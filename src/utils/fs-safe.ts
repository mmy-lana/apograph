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

/**
 * Derives a filesystem-safe subdirectory slug from a URL path for modular
 * evidence storage (`/` -> `index`, `/about-us` -> `about-us`). Unsafe
 * characters collapse to `-`; the result is bounded and never empty.
 */
export function slugForPath(pathname: string): string {
  const slug = pathname
    .split('/')
    .filter(Boolean)
    .join('-')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : 'index';
}

/**
 * Records a file path as bundle-relative for evidence manifests. Evidence
 * bundles must stay relocatable, so manifest references are stored relative
 * to the evidence directory (POSIX separators) and resolved back against it
 * by consumers. Paths that escape the bundle root are rejected loudly.
 */
export function toEvidenceRelativePath(root: string, path: string): string {
  const rootPath = resolve(root);
  const candidate = resolve(path);
  const rel = relative(rootPath, candidate);
  if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes authorized root: ${path}`);
  }
  return assertSafeRelativePath(rel.split(sep).join('/'));
}

/**
 * Resolves an evidence reference read from a manifest. Bundle-relative paths
 * are containment-checked and resolved against the evidence directory;
 * absolute paths written by older evidence bundles (or tooling predating
 * bundle-relative references) are honored as-is for compatibility.
 */
export function resolveEvidenceReference(root: string, path: string): string {
  if (isAbsolute(path)) return resolve(path);
  return resolveContainedPath(root, path);
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
