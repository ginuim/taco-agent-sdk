/**
 * Token Estimation & Counting
 *
 * Provides rough token estimation (character-based) and
 * API-based exact counting when available.
 */

/**
 * Rough token estimation.
 * ASCII text is about 4 chars/token; CJK characters are much denser.
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u.test(char)) {
      cjk++
    } else {
      other++
    }
  }
  return Math.ceil(cjk + other / 4)
}

/**
 * Estimate tokens for a message array.
 */
export function estimateMessagesTokens(
  messages: Array<{ role: string; content: any }>,
): number {
  let total = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ('text' in block && typeof block.text === 'string') {
          total += estimateTokens(block.text)
        } else if ('content' in block && typeof block.content === 'string') {
          total += estimateTokens(block.content)
        } else {
          // tool_use, image, etc - rough estimate
          total += estimateTokens(JSON.stringify(block))
        }
      }
    }
  }
  return total
}

/**
 * Estimate tokens for a system prompt.
 */
export function estimateSystemPromptTokens(systemPrompt: string): number {
  return estimateTokens(systemPrompt)
}

/**
 * Count tokens from API usage response.
 */
export function getTokenCountFromUsage(usage: {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0)
  )
}

/**
 * Get the context window size for a model.
 */
export function getContextWindowSize(model: string): number {
  const normalized = model.toLowerCase()
  // Anthropic model context windows
  if (normalized.includes('opus-4') && normalized.includes('1m')) return 1_000_000
  if (normalized.includes('opus-4')) return 200_000
  if (normalized.includes('sonnet-4')) return 200_000
  if (normalized.includes('haiku-4')) return 200_000
  if (normalized.includes('claude-3')) return 200_000

  // OpenAI model context windows
  if (normalized.startsWith('gpt-4o')) return 128_000
  if (normalized.startsWith('gpt-4-turbo')) return 128_000
  if (normalized.startsWith('gpt-4-1')) return 1_000_000
  if (normalized.startsWith('gpt-4')) return 128_000
  if (normalized.startsWith('gpt-3.5')) return 16_385
  if (normalized.startsWith('o1')) return 200_000
  if (normalized.startsWith('o3')) return 200_000
  if (normalized.startsWith('o4')) return 200_000

  // DeepSeek models
  if (normalized.includes('deepseek')) return 128_000

  // Default
  return 200_000
}

/**
 * Auto-compact buffer: trigger compaction when within this many tokens of the limit.
 */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000

/**
 * Get the auto-compact threshold for a model.
 */
export function getAutoCompactThreshold(model: string): number {
  return getContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS
}

/**
 * Model pricing (USD per token).
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic models
  'claude-opus-4-6': { input: 15 / 1_000_000, output: 75 / 1_000_000 },
  'claude-opus-4-5': { input: 15 / 1_000_000, output: 75 / 1_000_000 },
  'claude-sonnet-4-6': { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  'claude-sonnet-4-5': { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  'claude-haiku-4-5': { input: 0.8 / 1_000_000, output: 4 / 1_000_000 },
  'claude-3-5-sonnet': { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  'claude-3-5-haiku': { input: 0.8 / 1_000_000, output: 4 / 1_000_000 },
  'claude-3-opus': { input: 15 / 1_000_000, output: 75 / 1_000_000 },

  // OpenAI models
  'gpt-4o': { input: 2.5 / 1_000_000, output: 10 / 1_000_000 },
  'gpt-4o-mini': { input: 0.15 / 1_000_000, output: 0.6 / 1_000_000 },
  'gpt-4-turbo': { input: 10 / 1_000_000, output: 30 / 1_000_000 },
  'gpt-4-1': { input: 2 / 1_000_000, output: 8 / 1_000_000 },
  'o1': { input: 15 / 1_000_000, output: 60 / 1_000_000 },
  'o3': { input: 10 / 1_000_000, output: 40 / 1_000_000 },
  'o4-mini': { input: 1.1 / 1_000_000, output: 4.4 / 1_000_000 },

  // DeepSeek models
  'deepseek-chat': { input: 0.27 / 1_000_000, output: 1.1 / 1_000_000 },
  'deepseek-reasoner': { input: 0.55 / 1_000_000, output: 2.19 / 1_000_000 },
}

/**
 * Estimate cost from usage and model.
 */
export function estimateCost(
  model: string,
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  },
): number {
  const normalized = model.toLowerCase()
  const pricing = Object.entries(MODEL_PRICING)
    .sort(([a], [b]) => b.length - a.length)
    .find(([key]) => normalized === key || normalized.startsWith(`${key}-`))?.[1] ??
    { input: 3 / 1_000_000, output: 15 / 1_000_000 }

  const inputTokens =
    usage.input_tokens +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0)

  return inputTokens * pricing.input + usage.output_tokens * pricing.output
}
