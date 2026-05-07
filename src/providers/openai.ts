/**
 * OpenAI Chat Completions API Provider
 *
 * Converts between the SDK's internal Anthropic-like message format
 * and OpenAI's Chat Completions API format.
 *
 * Uses native fetch (no openai SDK dependency required).
 */

import type {
  LLMProvider,
  CreateMessageParams,
  CreateMessageResponse,
  MessageStreamEvent,
  NormalizedMessageParam,
  NormalizedContentBlock,
  NormalizedTool,
  NormalizedResponseBlock,
} from './types.js'

// --------------------------------------------------------------------------
// OpenAI-specific types (minimal, just what we need)
// --------------------------------------------------------------------------

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, any>
  }
}

interface OpenAIChatResponse {
  id: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: OpenAIToolCall[]
    }
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

interface OpenAIStreamToolState {
  id: string
  name: string
  arguments: string
  started: boolean
}

// --------------------------------------------------------------------------
// Provider
// --------------------------------------------------------------------------

export class OpenAIProvider implements LLMProvider {
  readonly apiType = 'openai-completions' as const
  private apiKey: string
  private baseURL: string

  constructor(opts: { apiKey?: string; baseURL?: string }) {
    this.apiKey = opts.apiKey || ''
    this.baseURL = (opts.baseURL || 'https://api.openai.com/v1').replace(/\/$/, '')
  }

  private buildRequestBody(params: CreateMessageParams): Record<string, any> {
    const messages = this.convertMessages(params.system, params.messages)
    const tools = params.tools ? this.convertTools(params.tools) : undefined

    const body: Record<string, any> = {
      model: params.model,
      max_tokens: params.maxTokens,
      messages,
    }

    if (tools && tools.length > 0) {
      body.tools = tools
    }

    return body
  }

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    const body = this.buildRequestBody(params)

    // Make API call
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errBody = await response.text().catch(() => '')
      const err: any = new Error(
        `OpenAI API error: ${response.status} ${response.statusText}: ${errBody}`,
      )
      err.status = response.status
      throw err
    }

    const data = (await response.json()) as OpenAIChatResponse

    // Convert response back to normalized format
    return this.convertResponse(data)
  }

  async *createMessageStream(params: CreateMessageParams): AsyncGenerator<MessageStreamEvent> {
    const body = {
      ...this.buildRequestBody(params),
      stream: true,
      stream_options: { include_usage: true },
    }

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errBody = await response.text().catch(() => '')
      const err: any = new Error(
        `OpenAI API error: ${response.status} ${response.statusText}: ${errBody}`,
      )
      err.status = response.status
      throw err
    }

    const textParts: string[] = []
    const toolStates = new Map<number, OpenAIStreamToolState>()
    let finishReason = 'stop'
    let usage: CreateMessageResponse['usage'] = {
      input_tokens: 0,
      output_tokens: 0,
    }

    for await (const data of this.iterSseData(response.body)) {
      if (data === '[DONE]') break

      const chunk = JSON.parse(data)
      if (chunk.usage) {
        usage = {
          input_tokens: chunk.usage.prompt_tokens ?? 0,
          output_tokens: chunk.usage.completion_tokens ?? 0,
        }
      }

      const choice = chunk.choices?.[0]
      if (!choice) continue

      if (choice.finish_reason) {
        finishReason = choice.finish_reason
      }

      const delta = choice.delta
      if (delta?.content) {
        textParts.push(delta.content)
        yield { type: 'text_delta', text: delta.content }
      }

      for (const toolCall of delta?.tool_calls ?? []) {
        const index = toolCall.index as number
        const state = toolStates.get(index) ?? {
          id: '',
          name: '',
          arguments: '',
          started: false,
        }

        if (toolCall.id) state.id = toolCall.id
        if (toolCall.function?.name) state.name = toolCall.function.name

        if (!state.started && state.id && state.name) {
          state.started = true
          yield {
            type: 'tool_use_start',
            index,
            id: state.id,
            name: state.name,
          }
        }

        const argumentDelta = toolCall.function?.arguments
        if (argumentDelta) {
          state.arguments += argumentDelta
          yield {
            type: 'tool_input_delta',
            index,
            inputDelta: argumentDelta,
          }
        }

        toolStates.set(index, state)
      }
    }

    const content: NormalizedResponseBlock[] = []
    const text = textParts.join('')
    if (text) {
      content.push({ type: 'text', text })
    }

    for (const state of toolStates.values()) {
      let input: any
      try {
        input = JSON.parse(state.arguments)
      } catch {
        input = state.arguments
      }

      content.push({
        type: 'tool_use',
        id: state.id,
        name: state.name,
        input,
      })
    }

    if (content.length === 0) {
      content.push({ type: 'text', text: '' })
    }

    yield {
      type: 'message',
      response: {
        content,
        stopReason: this.mapFinishReason(finishReason),
        usage,
      },
    }
  }

  // --------------------------------------------------------------------------
  // Message Conversion: Internal → OpenAI
  // --------------------------------------------------------------------------

  private convertMessages(
    system: string,
    messages: NormalizedMessageParam[],
  ): OpenAIChatMessage[] {
    const result: OpenAIChatMessage[] = []

    // System prompt as first message
    if (system) {
      result.push({ role: 'system', content: system })
    }

    for (const msg of messages) {
      if (msg.role === 'user') {
        this.convertUserMessage(msg, result)
      } else if (msg.role === 'assistant') {
        this.convertAssistantMessage(msg, result)
      }
    }

    return result
  }

  private convertUserMessage(
    msg: NormalizedMessageParam,
    result: OpenAIChatMessage[],
  ): void {
    if (typeof msg.content === 'string') {
      result.push({ role: 'user', content: msg.content })
      return
    }

    // Content blocks may contain text and/or tool_result blocks
    const textParts: string[] = []
    const toolResults: Array<{ tool_use_id: string; content: string }> = []

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text)
      } else if (block.type === 'tool_result') {
        toolResults.push({
          tool_use_id: block.tool_use_id,
          content: block.content,
        })
      }
    }

    // Tool results become separate tool messages
    for (const tr of toolResults) {
      result.push({
        role: 'tool',
        tool_call_id: tr.tool_use_id,
        content: tr.content,
      })
    }

    // Text parts become a user message
    if (textParts.length > 0) {
      result.push({ role: 'user', content: textParts.join('\n') })
    }
  }

  private convertAssistantMessage(
    msg: NormalizedMessageParam,
    result: OpenAIChatMessage[],
  ): void {
    if (typeof msg.content === 'string') {
      result.push({ role: 'assistant', content: msg.content })
      return
    }

    // Extract text and tool_use blocks
    const textParts: string[] = []
    const toolCalls: OpenAIToolCall[] = []

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text)
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: typeof block.input === 'string'
              ? block.input
              : JSON.stringify(block.input),
          },
        })
      }
    }

    const assistantMsg: OpenAIChatMessage = {
      role: 'assistant',
      content: textParts.length > 0 ? textParts.join('\n') : null,
    }

    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls
    }

    result.push(assistantMsg)
  }

  // --------------------------------------------------------------------------
  // Tool Conversion: Internal → OpenAI
  // --------------------------------------------------------------------------

  private convertTools(tools: NormalizedTool[]): OpenAITool[] {
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }))
  }

  // --------------------------------------------------------------------------
  // Response Conversion: OpenAI → Internal
  // --------------------------------------------------------------------------

  private convertResponse(data: OpenAIChatResponse): CreateMessageResponse {
    const choice = data.choices[0]
    if (!choice) {
      return {
        content: [{ type: 'text', text: '' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    }

    const content: NormalizedResponseBlock[] = []

    // Add text content
    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content })
    }

    // Add tool calls
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let input: any
        try {
          input = JSON.parse(tc.function.arguments)
        } catch {
          input = tc.function.arguments
        }

        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        })
      }
    }

    // If no content at all, add empty text
    if (content.length === 0) {
      content.push({ type: 'text', text: '' })
    }

    // Map finish_reason to our normalized stop reasons
    const stopReason = this.mapFinishReason(choice.finish_reason)

    return {
      content,
      stopReason,
      usage: {
        input_tokens: data.usage?.prompt_tokens || 0,
        output_tokens: data.usage?.completion_tokens || 0,
      },
    }
  }

  private mapFinishReason(
    reason: string,
  ): 'end_turn' | 'max_tokens' | 'tool_use' | string {
    switch (reason) {
      case 'stop':
        return 'end_turn'
      case 'length':
        return 'max_tokens'
      case 'tool_calls':
        return 'tool_use'
      default:
        return reason
    }
  }

  private async *iterSseData(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
    if (!body) throw new Error('OpenAI stream response has no body')

    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          yield trimmed.slice('data:'.length).trim()
        }
      }

      buffer += decoder.decode()
      for (const line of buffer.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed.startsWith('data:')) {
          yield trimmed.slice('data:'.length).trim()
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
}
