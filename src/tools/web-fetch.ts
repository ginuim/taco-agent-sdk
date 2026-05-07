/**
 * WebFetchTool - Fetch web content
 */

import { defineTool } from './types.js'

const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal'])
const BLOCKED_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'host',
  'proxy-authorization',
])

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }

  const [a, b] = parts
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  )
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return (
    BLOCKED_HOSTS.has(normalized) ||
    normalized.endsWith('.localhost') ||
    isPrivateIpv4(normalized) ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  )
}

function validateUrl(
  rawUrl: string,
  options?: { allowedDomains?: string[]; allowLocalBinding?: boolean },
): URL {
  const parsed = new URL(rawUrl)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed')
  }
  const allowLocalBinding = Boolean(options?.allowLocalBinding)
  if (!allowLocalBinding && isBlockedHostname(parsed.hostname)) {
    throw new Error(`Blocked private or local URL: ${parsed.hostname}`)
  }
  if (options?.allowedDomains?.length) {
    const hostname = parsed.hostname.toLowerCase()
    const allowed = options.allowedDomains.some((domain) => {
      const normalized = domain.toLowerCase()
      return hostname === normalized || hostname.endsWith(`.${normalized}`)
    })
    if (!allowed) {
      throw new Error(`Domain is not allowed: ${parsed.hostname}`)
    }
  }
  return parsed
}

function sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const safeHeaders: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (BLOCKED_HEADER_NAMES.has(name.toLowerCase())) continue
    safeHeaders[name] = String(value)
  }
  return safeHeaders
}

export const WebFetchTool = defineTool({
  name: 'WebFetch',
  description: 'Fetch content from a URL and return it as text. Supports HTML pages, JSON APIs, and plain text. Strips HTML tags for readability.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch content from',
      },
      headers: {
        type: 'object',
        description: 'Optional HTTP headers',
      },
    },
    required: ['url'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context) {
    const { url, headers } = input

    try {
      const parsedUrl = validateUrl(url, {
        allowedDomains: context.sandbox?.network?.allowedDomains,
        allowLocalBinding: context.sandbox?.network?.allowLocalBinding,
      })
      const response = await fetch(parsedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AgentSDK/1.0)',
          ...sanitizeHeaders(headers),
        },
        signal: AbortSignal.timeout(30000),
      })

      if (!response.ok) {
        return { data: `HTTP ${response.status}: ${response.statusText}`, is_error: true }
      }

      const contentType = response.headers.get('content-type') || ''
      let text = await response.text()

      // Strip HTML tags for readability
      if (contentType.includes('text/html')) {
        // Remove script and style blocks
        text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        // Remove HTML tags
        text = text.replace(/<[^>]+>/g, ' ')
        // Clean up whitespace
        text = text.replace(/\s+/g, ' ').trim()
      }

      // Truncate very large responses
      if (text.length > 100000) {
        text = text.slice(0, 100000) + '\n...(truncated)'
      }

      return text || '(empty response)'
    } catch (err: any) {
      return { data: `Error fetching ${url}: ${err.message}`, is_error: true }
    }
  },
})
