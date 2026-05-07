import assert from 'node:assert/strict'
import { QueryEngine } from '../src/engine.js'
import type {
  CreateMessageParams,
  CreateMessageResponse,
  LLMProvider,
} from '../src/providers/types.js'
import type { SDKMessage, ToolDefinition } from '../src/types.js'

type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; index: number; id: string; name: string }
  | { type: 'tool_input_delta'; index: number; inputDelta: string }
  | { type: 'message'; response: CreateMessageResponse }

class StreamingOnlyProvider implements LLMProvider {
  readonly apiType = 'anthropic-messages' as const

  constructor(private readonly events: StreamEvent[]) {}

  async createMessage(_params: CreateMessageParams): Promise<CreateMessageResponse> {
    throw new Error('createMessage should not be used when partial messages are enabled')
  }

  async *createMessageStream(_params: CreateMessageParams): AsyncGenerator<StreamEvent> {
    for (const event of this.events) {
      yield event
    }
  }
}

function createEngine(provider: LLMProvider, tools: ToolDefinition[] = []): QueryEngine {
  return new QueryEngine({
    cwd: process.cwd(),
    model: 'test-model',
    provider,
    tools,
    maxTurns: 1,
    maxTokens: 1000,
    includePartialMessages: true,
    canUseTool: async () => ({ behavior: 'allow' }),
  })
}

async function collect(engine: QueryEngine): Promise<SDKMessage[]> {
  const events: SDKMessage[] = []
  for await (const event of engine.submitMessage('go')) {
    events.push(event)
  }
  return events
}

async function testTextDeltas() {
  const provider = new StreamingOnlyProvider([
    { type: 'text_delta', text: 'Hel' },
    { type: 'text_delta', text: 'lo' },
    {
      type: 'message',
      response: {
        content: [{ type: 'text', text: 'Hello' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ])

  const events = await collect(createEngine(provider))
  const partials = events.filter((event) => event.type === 'partial_message')

  assert.deepEqual(
    partials.map((event) => event.partial),
    [
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ],
  )
}

async function testWriteContentDeltas() {
  const writeTool: ToolDefinition = {
    name: 'Write',
    description: 'write a file',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
    },
    async call() {
      return {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: 'ok',
      }
    },
  }

  const provider = new StreamingOnlyProvider([
    { type: 'tool_use_start', index: 0, id: 'toolu_1', name: 'Write' },
    {
      type: 'tool_input_delta',
      index: 0,
      inputDelta: '{"file_path":"demo.md","content":"Hello ',
    },
    { type: 'tool_input_delta', index: 0, inputDelta: 'world"}' },
    {
      type: 'message',
      response: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Write',
            input: { file_path: 'demo.md', content: 'Hello world' },
          },
        ],
        stopReason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ])

  const events = await collect(createEngine(provider, [writeTool]))
  const partials = events.filter((event) => event.type === 'partial_message')

  assert.deepEqual(
    partials.map((event) => event.partial),
    [
      { type: 'tool_use', name: 'Write', field: 'content', input: 'Hello ' },
      { type: 'tool_use', name: 'Write', field: 'content', input: 'world' },
    ],
  )
}

await testTextDeltas()
await testWriteContentDeltas()
