/**
 * GlobTool - File pattern matching
 */

import { defineTool } from './types.js'
import { resolveAllowedPath } from '../utils/path.js'

export const GlobTool = defineTool({
  name: 'Glob',
  description: 'Find files matching a glob pattern. Returns matching file paths sorted by modification time. Supports patterns like "**/*.ts", "src/**/*.js".',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The glob pattern to match files against',
      },
      path: {
        type: 'string',
        description: 'The directory to search in (defaults to cwd)',
      },
    },
    required: ['pattern'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context) {
    const searchDir = input.path
      ? resolveAllowedPath(context.cwd, input.path, context.allowedDirectories)
      : context.cwd
    const { pattern } = input

    try {
      // Use Node.js glob (available in Node 22+) or fall back to bash find
      const { glob } = await import('fs/promises')

      // @ts-ignore - glob is available in Node 22+
      if (typeof glob === 'function') {
        const matches: string[] = []
        // @ts-ignore
        for await (const entry of glob(pattern, { cwd: searchDir })) {
          matches.push(entry)
          if (matches.length >= 500) break
        }
        if (matches.length === 0) {
          return `No files matching pattern "${pattern}" in ${searchDir}`
        }
        return matches.join('\n')
      }
    } catch {
      // Fall through to bash-based approach
    }

    // Fallback: use bash find/glob
    const { spawn } = await import('child_process')
    return new Promise<string>((resolvePromise) => {
      const proc = spawn('bash', ['-c', 'shopt -s globstar nullglob; compgen -G "$PATTERN" | head -500'], {
        cwd: searchDir,
        env: { PATH: process.env.PATH, PATTERN: pattern },
        timeout: 30000,
      })

      const chunks: Buffer[] = []
      proc.stdout?.on('data', (d: Buffer) => chunks.push(d))
      proc.on('close', () => {
        const result = Buffer.concat(chunks).toString('utf-8').trim()
        if (!result) {
          resolvePromise(`No files matching pattern "${pattern}" in ${searchDir}`)
        } else {
          resolvePromise(result)
        }
      })
      proc.on('error', () => {
        resolvePromise(`Error searching for files with pattern "${pattern}"`)
      })
    })
  },
})
