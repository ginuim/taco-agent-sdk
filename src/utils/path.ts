import { resolve, relative, isAbsolute } from 'path'

function expandHome(pathValue: string): string {
  if (pathValue === '~') return process.env.HOME || pathValue
  if (pathValue.startsWith('~/')) {
    const home = process.env.HOME
    if (!home) return pathValue
    return resolve(home, pathValue.slice(2))
  }
  return pathValue
}

export function resolveAllowedPath(
  cwd: string,
  inputPath: string,
  allowedDirectories: string[] = [cwd],
): string {
  const resolvedPath = resolve(cwd, expandHome(inputPath))
  const allowedRoots = allowedDirectories.map((dir) => resolve(cwd, expandHome(dir)))

  if (!allowedRoots.some((root) => isPathInside(resolvedPath, root))) {
    throw new Error(`Path is outside allowed directories: ${inputPath}`)
  }

  return resolvedPath
}

export function isPathInside(path: string, root: string): boolean {
  const relativePath = relative(root, path)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}
