import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Rejects absolute paths, traversal, empty segments, and NUL bytes. */
export function assertSafeRelativePath(path: string): string {
  if (path.length === 0 || path.includes('\0') || isAbsolute(path)) {
    throw new Error(`Unsafe relative path: ${path}`);
  }
  const normalized = path.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new Error(`Unsafe relative path: ${path}`);
  }
  return normalized;
}

/** Resolves a relative path and proves lexical containment under root. */
export function resolveContainedPath(root: string, path: string): string {
  const safe = assertSafeRelativePath(path);
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, safe);
  const rel = relative(rootPath, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes authorized root: ${path}`);
  }
  return candidate;
}

/** Rejects symlink components in an existing path beneath root. */
export async function assertNoSymlinkComponents(root: string, candidate: string): Promise<void> {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const rel = relative(rootPath, candidatePath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes authorized root: ${candidate}`);
  }
  const parts = rel.split(sep).filter(Boolean);
  let current = rootPath;
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Symlink path component is not allowed: ${current}`);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw cause;
    }
  }
}

/** Creates a parent and writes only after checking existing path components. */
export async function writeContainedFile(root: string, path: string, content: string): Promise<string> {
  const candidate = resolveContainedPath(root, path);
  await mkdir(dirname(candidate), { recursive: true });
  await assertNoSymlinkComponents(root, candidate);
  await writeFile(candidate, content, { encoding: 'utf8', flag: 'wx' });
  return candidate;
}

/** Canonicalizes an existing path and verifies it remains under root. */
export async function realpathContained(root: string, candidate: string): Promise<string> {
  const rootReal = await realpath(root);
  const candidateReal = await realpath(candidate);
  const rel = relative(rootReal, candidateReal);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes authorized root: ${candidate}`);
  }
  return candidateReal;
}
