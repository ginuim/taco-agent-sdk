/**
 * Anthropic Messages API Provider
 *
 * Wraps the @anthropic-ai/sdk client. Since our internal format is
 * Anthropic-like, this is mostly a thin pass-through.
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  LLMProvider,
  CreateMessageParams,
  CreateMessageResponse,
  MessageStreamEvent,
} from './types.js'

export class AnthropicProvider implements LLMProvider {
  readonly apiType = 'anthropic-messages' as const
  private client: Anthropic

  constructor(opts: { apiKey?: string; baseURL?: string }) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    })
  }

  private buildRequestParams(params: CreateMessageParams): Anthropic.MessageCreateParamsNonStreaming {
    const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages as Anthropic.MessageParam[],
      tools: params.tools
        ? (params.tools as Anthropic.Tool[])
        : undefined,
    }

    // Add extended thinking if configured
    if (params.thinking?.type === 'enabled' && params.thinking.budget_tokens) {
      (requestParams as any).thinking = {
        type: 'enabled',
        budget_tokens: params.thinking.budget_tokens,
      }
    }

    return requestParams
  }

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    const requestParams = this.buildRequestParams(params)
    const response = await this.client.messages.create(requestParams)

    return {
      content: response.content as CreateMessageResponse['content'],
      stopReason: response.stop_reason || 'end_turn',
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens:
          (response.usage as any).cache_creation_input_tokens,
        cache_read_input_tokens:
          (response.usage as any).cache_read_input_tokens,
      },
    }
  }

  async *createMessageStream(params: CreateMessageParams): AsyncGenerator<MessageStreamEvent> {
    const requestParams = this.buildRequestParams(params)
    const stream = await this.client.messages.create({
      ...(requestParams as any),
      stream: true,
    })

    const content: CreateMessageResponse['content'] = []
    const toolInputs = new Map<number, string>()
    const usage: CreateMessageResponse['usage'] = {
      input_tokens: 0,
      output_tokens: 0,
    }
    let stopReason: CreateMessageResponse['stopReason'] = 'end_turn'

    for await (const event of stream as any) {
      switch (event.type) {
        case 'message_start':
          usage.input_tokens = event.message?.usage?.input_tokens ?? 0
          usage.output_tokens = event.message?.usage?.output_tokens ?? 0
          usage.cache_creation_input_tokens =
            event.message?.usage?.cache_creation_input_tokens
          usage.cache_read_input_tokens =
            event.message?.usage?.cache_read_input_tokens
          break

        case 'content_block_start': {
          const index = event.index as number
          const block = event.content_block
          if (block?.type === 'text') {
            content[index] = { type: 'text', text: block.text ?? '' }
          } else if (block?.type === 'tool_use') {
            content[index] = {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: {},
            }
            toolInputs.set(index, '')
            yield {
              type: 'tool_use_start',
              index,
              id: block.id,
              name: block.name,
            }
          }
          break
        }

        case 'content_block_delta': {
          const index = event.index as number
          const delta = event.delta
          if (delta?.type === 'text_delta' && delta.text) {
            const block = content[index]
            if (block?.type === 'text') {
              block.text += delta.text
            } else {
              content[index] = { type: 'text', text: delta.text }
            }
            yield { type: 'text_delta', text: delta.text }
          } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
            toolInputs.set(index, (toolInputs.get(index) ?? '') + delta.partial_json)
            yield {
              type: 'tool_input_delta',
              index,
              inputDelta: delta.partial_json,
            }
          }
          break
        }

        case 'content_block_stop': {
          const index = event.index as number
          const block = content[index]
          if (block?.type === 'tool_use') {
            const inputJson = toolInputs.get(index) ?? '{}'
            try {
              block.input = JSON.parse(inputJson)
            } catch {
              block.input = inputJson
            }
          }
          break
        }

        case 'message_delta':
          stopReason = event.delta?.stop_reason ?? stopReason
          if (event.usage?.output_tokens !== undefined) {
            usage.output_tokens = event.usage.output_tokens
          }
          break
      }
    }

    yield {
      type: 'message',
      response: {
        content: content.filter(Boolean),
        stopReason,
        usage,
      },
    }
  }
}
