import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { QueryEngine } from '../src/engine.js'
import { FileReadTool } from '../src/tools/read.js'
import { FileWriteTool } from '../src/tools/write.js'
import { FileEditTool } from '../src/tools/edit.js'
import { BashTool } from '../src/tools/bash.js'
import { WebFetchTool } from '../src/tools/web-fetch.js'
import { estimateCost, estimateTokens } from '../src/utils/tokens.js'
import { isPromptTooLongError, withRetry } from '../src/utils/retry.js'
import type { CreateMessageParams, CreateMessageResponse, LLMProvider } from '../src/providers/types.js'
import type { ToolDefinition } from '../src/types.js'

class QueueProvider implements LLMProvider {
  readonly apiType = 'anthropic-messages' as const
  calls = 0

  constructor(private readonly responses: CreateMessageResponse[]) {}

  async createMessage(_params: CreateMessageParams): Promise<CreateMessageResponse> {
    const response = this.responses[this.calls++]
    if (!response) throw new Error('unexpected provider call')
    return response
  }
}

async function testFileToolsRejectTraversal() {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-sdk-cwd-'))
  const outside = await mkdtemp(join(tmpdir(), 'agent-sdk-outside-'))
  const outsideFile = join(outside, 'secret.txt')
  await writeFile(outsideFile, 'secret', 'utf-8')

  try {
    const context = { cwd }
    const read = await FileReadTool.call({ file_path: outsideFile }, context)
    const write = await FileWriteTool.call({ file_path: outsideFile, content: 'changed' }, context)
    const edit = await FileEditTool.call({
      file_path: outsideFile,
      old_string: 'secret',
      new_string: 'changed',
    }, context)

    assert.equal(read.is_error, true)
    assert.equal(write.is_error, true)
    assert.equal(edit.is_error, true)
    assert.equal(await readFile(outsideFile, 'utf-8'), 'secret')
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
}

async function testWebFetchRejectsPrivateUrlsBeforeFetch() {
  const originalFetch = globalThis.fetch
  let called = false
  globalThis.fetch = (async () => {
    called = true
    throw new Error('fetch should not be called')
  }) as typeof fetch

  try {
    const result = await WebFetchTool.call({ url: 'http://169.254.169.254/latest/meta-data/' }, { cwd: process.cwd() })
    assert.equal(result.is_error, true)
    assert.equal(called, false)
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function testBashMarksNonZeroExitAsError() {
  const result = await BashTool.call({ command: 'exit 7' }, { cwd: process.cwd() })
  assert.equal(result.is_error, true)
  assert.match(String(result.content), /Exit code: 7/)
}

async function testEngineContinuesAfterToolResultWithEndTurn() {
  const tool: ToolDefinition = {
    name: 'Echo',
    description: 'echo input',
    inputSchema: { type: 'object', properties: {}, required: [] },
    isReadOnly: () => true,
    async call() {
      return { type: 'tool_result', tool_use_id: '', content: 'tool output' }
    },
  }

  const provider = new QueueProvider([
    {
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Echo', input: {} }],
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    {
      content: [{ type: 'text', text: 'saw tool output' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  ])
  const engine = new QueryEngine({
    cwd: process.cwd(),
    model: 'test-model',
    provider,
    tools: [tool],
    maxTurns: 3,
    maxTokens: 1000,
    includePartialMessages: false,
    canUseTool: async () => ({ behavior: 'allow' }),
  })

  for await (const _event of engine.submitMessage('go')) {
    // drain
  }

  assert.equal(provider.calls, 2)
}

async function testRetryDoesNotCompactForMaxTokensParameterError() {
  const err = {
    status: 400,
    message: 'max_tokens must be between 1 and 8192',
  }
  assert.equal(isPromptTooLongError(err), false)
}

async function testRetrySleepAborts() {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 20)
  let attempts = 0

  await assert.rejects(
    () => withRetry(
      async () => {
        attempts++
        const err: any = new Error('rate limited')
        err.status = 429
        throw err
      },
      { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 1000, retryableStatusCodes: [429] },
      controller.signal,
    ),
    /Aborted/,
  )
  assert.equal(attempts, 1)
}

function testTokenEstimationAndModelPricing() {
  assert.ok(estimateTokens('这是中文测试文本') >= 8)
  const cost = estimateCost('gpt-4o-mini', { input_tokens: 1_000_000, output_tokens: 1_000_000 })
  assert.equal(cost, 0.75)
}

await testFileToolsRejectTraversal()
await testWebFetchRejectsPrivateUrlsBeforeFetch()
await testBashMarksNonZeroExitAsError()
await testEngineContinuesAfterToolResultWithEndTurn()
await testRetryDoesNotCompactForMaxTokensParameterError()
await testRetrySleepAborts()
testTokenEstimationAndModelPricing()
