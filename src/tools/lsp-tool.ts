/**
 * LSPTool - Language Server Protocol integration
 *
 * Provides code intelligence: go-to-definition, find-references,
 * hover, document symbols, workspace symbols, etc.
 */

import { execFileSync } from 'child_process'
import type { ToolDefinition, ToolResult, ToolContext } from '../types.js'
import { resolveAllowedPath } from '../utils/path.js'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function runRg(args: string[], cwd: string): string {
  try {
    return execFileSync('rg', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch (err: any) {
    return String(err?.stdout ?? '').trim()
  }
}

function firstLines(text: string, limit: number): string {
  return text.split('\n').slice(0, limit).join('\n')
}

export const LSPTool: ToolDefinition = {
  name: 'LSP',
  description: 'Language Server Protocol operations for code intelligence. Supports go-to-definition, find-references, hover, and symbol lookup.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [
          'goToDefinition',
          'findReferences',
          'hover',
          'documentSymbol',
          'workspaceSymbol',
          'goToImplementation',
          'prepareCallHierarchy',
          'incomingCalls',
          'outgoingCalls',
        ],
        description: 'LSP operation to perform',
      },
      file_path: { type: 'string', description: 'File path for the operation' },
      line: { type: 'number', description: 'Line number (0-based)' },
      character: { type: 'number', description: 'Character position (0-based)' },
      query: { type: 'string', description: 'Symbol name (for workspace symbol search)' },
    },
    required: ['operation'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Code intelligence via Language Server Protocol.' },
  async call(input: any, context: ToolContext): Promise<ToolResult> {
    const { operation, file_path, line, character, query } = input

    // LSP requires a running language server. In standalone mode,
    // we fall back to basic grep/ripgrep-based symbol lookup.
    try {
      switch (operation) {
        case 'goToDefinition':
        case 'goToImplementation': {
          if (!file_path || line === undefined) {
            return { type: 'tool_result', tool_use_id: '', content: 'file_path and line required', is_error: true }
          }
          // Use grep to find definition
          const symbol = await getSymbolAtPosition(file_path, line, character || 0, context.cwd, context.allowedDirectories)
          if (!symbol) {
            return { type: 'tool_result', tool_use_id: '', content: 'Could not identify symbol at position' }
          }
          const results = runRg([
            '-n',
            `(?:function|class|interface|type|const|let|var|export)\\s+${escapeRegExp(symbol)}`,
            '--type-add',
            'src:*.{ts,tsx,js,jsx,py,go,rs,java}',
            '-t',
            'src',
            context.cwd,
          ], context.cwd)
          return { type: 'tool_result', tool_use_id: '', content: results || `No definition found for "${symbol}"` }
        }

        case 'findReferences': {
          if (!file_path || line === undefined) {
            return { type: 'tool_result', tool_use_id: '', content: 'file_path and line required', is_error: true }
          }
          const sym = await getSymbolAtPosition(file_path, line, character || 0, context.cwd, context.allowedDirectories)
          if (!sym) {
            return { type: 'tool_result', tool_use_id: '', content: 'Could not identify symbol at position' }
          }
          const refs = firstLines(runRg([
            '-n',
            escapeRegExp(sym),
            context.cwd,
            '--type-add',
            'src:*.{ts,tsx,js,jsx,py,go,rs,java}',
            '-t',
            'src',
          ], context.cwd), 50)
          return { type: 'tool_result', tool_use_id: '', content: refs || `No references found for "${sym}"` }
        }

        case 'hover': {
          return {
            type: 'tool_result',
            tool_use_id: '',
            content: 'Hover information requires a running language server. Use Read tool to examine the file content.',
          }
        }

        case 'documentSymbol': {
          if (!file_path) {
            return { type: 'tool_result', tool_use_id: '', content: 'file_path required', is_error: true }
          }
          const safePath = resolveAllowedPath(context.cwd, file_path, context.allowedDirectories)
          const symbols = runRg([
            '-n',
            '^\\s*(export\\s+)?(function|class|interface|type|const|let|var|enum)\\s+',
            safePath,
          ], context.cwd)
          return { type: 'tool_result', tool_use_id: '', content: symbols || 'No symbols found' }
        }

        case 'workspaceSymbol': {
          if (!query) {
            return { type: 'tool_result', tool_use_id: '', content: 'query required', is_error: true }
          }
          const wsSymbols = firstLines(runRg([
            '-n',
            escapeRegExp(query),
            context.cwd,
            '--type-add',
            'src:*.{ts,tsx,js,jsx,py,go,rs,java}',
            '-t',
            'src',
          ], context.cwd), 30)
          return { type: 'tool_result', tool_use_id: '', content: wsSymbols || `No symbols found for "${query}"` }
        }

        default:
          return {
            type: 'tool_result',
            tool_use_id: '',
            content: `LSP operation "${operation}" requires a running language server.`,
          }
      }
    } catch (err: any) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `LSP error: ${err.message}`,
        is_error: true,
      }
    }
  },
}

/**
 * Get the symbol at a given position in a file.
 */
async function getSymbolAtPosition(
  filePath: string,
  line: number,
  character: number,
  cwd: string,
  allowedDirectories?: string[],
): Promise<string | null> {
  try {
    const { readFile } = await import('fs/promises')
    const content = await readFile(resolveAllowedPath(cwd, filePath, allowedDirectories), 'utf-8')
    const lines = content.split('\n')

    if (line >= lines.length) return null

    const lineText = lines[line]
    if (!lineText || character >= lineText.length) return null

    // Extract word at position
    const wordMatch = /\b\w+\b/g
    let match
    while ((match = wordMatch.exec(lineText)) !== null) {
      if (match.index <= character && match.index + match[0].length >= character) {
        return match[0]
      }
    }

    return null
  } catch {
    return null
  }
}
