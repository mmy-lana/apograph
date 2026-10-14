/**
 * apograph — Smoke verification & self-healing (Layer 5: Output).
 *
 * Runs `tsc --noEmit` against the emitted project, parses diagnostics, and
 * routes failing files through the LLM repair loop until the build is clean
 * or the pass budget is exhausted.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { repairCodeFile } from '../synthesizer/llm.js';

/** Promisified execFile for async child-process execution. */
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Diagnostic parsing
// ---------------------------------------------------------------------------

/** A single parsed TypeScript compiler diagnostic. */
export interface TscError {
  filePath: string;
  line: number;
  message: string;
}

/** Matches `path/to/file.ts(line,col): error TSxxxx: message`. */
const TSC_ERROR_RE = /^(.+?)\((\d+),(\d+)\):\s+(error TS\d+: .+)$/;

/**
 * Parses standard TypeScript compiler output into structured diagnostics.
 * Non-error lines (banners, "Found N errors" summaries) are ignored.
 */
export function parseTscErrors(output: string): TscError[] {
  const errors: TscError[] = [];

  for (const line of output.split('\n')) {
    const match = TSC_ERROR_RE.exec(line.trim());
    if (!match) continue;

    const filePath = match[1];
    const lineNo = Number.parseInt(match[2] ?? '0', 10);
    const message = match[4] ?? '';

    if (filePath && !Number.isNaN(lineNo)) {
      errors.push({ filePath, line: lineNo, message });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Compiler runner
// ---------------------------------------------------------------------------

/** Result of one typecheck run. */
export interface TypecheckResult {
  success: boolean;
  errors: string[];
  rawOutput: string;
}

/**
 * Runs `npx tsc --noEmit` inside `cwd` and parses the diagnostics. A zero
 * exit code yields `{ success: true, errors: [] }`; otherwise every parsed
 * `path(line,col): error TS...: message` line is returned as a string.
 */
export async function runTypecheck(cwd: string): Promise<TypecheckResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'npx',
      ['tsc', '--noEmit'],
      { cwd },
    );
    return {
      success: true,
      errors: [],
      rawOutput: `${stdout}${stderr}`.trim(),
    };
  } catch (cause) {
    // Non-zero exit: tsc writes diagnostics to stdout (and sometimes stderr).
    const failure = cause as { stdout?: string; stderr?: string; message?: string };
    const rawOutput =
      `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim() ||
      (failure.message ?? '');
    const errors = parseTscErrors(rawOutput).map(
      (error) => `${error.filePath}(${error.line}): ${error.message}`,
    );
    return { success: false, errors, rawOutput };
  }
}

// ---------------------------------------------------------------------------
// Self-healing verification
// ---------------------------------------------------------------------------

/** Result of the full verify-and-self-heal loop. */
export interface VerifyResult {
  success: boolean;
  passesRun: number;
  repairedFiles: string[];
}

/** True when a directory contains a tsconfig.json. */
async function hasTsConfig(dir: string): Promise<boolean> {
  try {
    await readFile(join(dir, 'tsconfig.json'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Maps a diagnostic string back to its file path (`path(line): message`). */
function filePathOfErrorLine(errorLine: string): string {
  const openParen = errorLine.indexOf('(');
  return openParen > 0 ? errorLine.slice(0, openParen) : errorLine;
}

/**
 * Discovers the typecheck roots: `./frontend` and `./backend` when they have
 * a tsconfig.json, otherwise the project root itself.
 */
async function discoverTypecheckRoots(projectDir: string): Promise<string[]> {
  const frontendDir = join(projectDir, 'frontend');
  const backendDir = join(projectDir, 'backend');

  const roots: string[] = [];
  if (await hasTsConfig(frontendDir)) roots.push(frontendDir);
  if (await hasTsConfig(backendDir)) roots.push(backendDir);

  if (roots.length === 0 && (await hasTsConfig(projectDir))) {
    roots.push(projectDir);
  }

  return roots;
}

/**
 * Verifies the emitted project with `tsc --noEmit` and self-heals failing
 * files: errors are grouped per file, each file is sent through
 * `repairCodeFile`, overwritten on disk, and re-checked. Runs at most
 * `maxPasses` repair passes across all typecheck roots.
 */
export async function verifyAndSelfHeal(
  projectDir: string,
  maxPasses: number = 2,
): Promise<VerifyResult> {
  const projectRoot = resolve(projectDir);
  const roots = await discoverTypecheckRoots(projectRoot);
  const repairedFiles = new Set<string>();
  let passesRun = 0;

  // Track per-root error state so each root gets its own repair budget.
  const pendingRoots = new Set(roots);

  while (pendingRoots.size > 0 && passesRun < maxPasses) {
    passesRun += 1;
    const nextPending: string[] = [];

    for (const root of pendingRoots) {
      const result = await runTypecheck(root);

      if (result.success) continue;

      // Group raw error lines by file path.
      const errorsByFile = new Map<string, string[]>();
      for (const errorLine of result.errors) {
        const filePath = filePathOfErrorLine(errorLine);
        const existing = errorsByFile.get(filePath);
        if (existing) {
          existing.push(errorLine);
        } else {
          errorsByFile.set(filePath, [errorLine]);
        }
      }

      // Repair each failing file.
      for (const [relativePath, fileErrors] of errorsByFile) {
        const absolutePath = resolve(root, relativePath);

        let currentContent: string;
        try {
          currentContent = await readFile(absolutePath, 'utf8');
        } catch {
          // File unreadable (deleted or generated outside our control);
          // nothing to repair against.
          continue;
        }

        const repaired = await repairCodeFile(absolutePath, currentContent, fileErrors);
        await writeFile(absolutePath, repaired, 'utf8');
        repairedFiles.add(absolutePath);
      }

      nextPending.push(root);
    }

    pendingRoots.clear();
    for (const root of nextPending) pendingRoots.add(root);
  }

  // Final verdict: re-check every discovered root once after the last pass.
  let allClean = true;
  for (const root of roots) {
    const finalCheck = await runTypecheck(root);
    if (!finalCheck.success) {
      allClean = false;
      break;
    }
  }

  return {
    success: allClean,
    passesRun,
    repairedFiles: [...repairedFiles],
  };
}
