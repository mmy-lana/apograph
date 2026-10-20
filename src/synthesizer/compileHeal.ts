/**
 * apograph — synthesis-time compile convergence (pre-verification
 * self-healing).
 *
 * Vision synthesis occasionally emits code that does not typecheck (e.g. a
 * malformed nested data literal passed inline into a typed JSX prop). The
 * 3-tier verifier's build tier has its own bounded repair turn, but a
 * generator that ships invalid TypeScript has already failed the emitted
 * project before verification starts — and residual type errors correlate
 * with runtime crashes the pixel score cannot reveal.
 *
 * This module closes the loop INSIDE the generation pipeline: after emit,
 * the project is typechecked (`tsc --noEmit`) and failing source files are
 * sent through the existing `repairCodeFile` primitive in bounded turns
 * until the project compiles or the budget is exhausted. Everything it
 * touches is generated output; the verifier, its thresholds, and its
 * repair budget are never involved.
 *
 * Policy: running generated-project tooling (dependency install, tsc)
 * requires `APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION=1`, mirroring the
 * verifier's own execution gate. When the gate is off, healing is skipped
 * and reported as such — the verifier then behaves exactly as configured.
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { repairCodeFile } from './llm.js';

/** Default bounded repair turns (the loop is always finite). */
const DEFAULT_MAX_TURNS = 2;

/** Default max files sent through repair per turn (token bound). */
const DEFAULT_MAX_FILES_PER_TURN = 3;

/** Hard cap on diagnostics considered per file (token bound). */
const MAX_ERRORS_PER_FILE = 8;

/** One process run result (stdout+stderr merged by the default runner). */
export interface CommandResult {
  ok: boolean;
  output: string;
}

/** Injectable collaborators (tests use deterministic fakes). */
export interface CompileHealDeps {
  /** Runs a command in the emitted project (defaults to execFile). */
  run?: (command: string, args: string[], cwd: string) => Promise<CommandResult>;
  /** Repair hook (defaults to `repairCodeFile`). */
  repairFile?: (filePath: string, content: string, errors: string[]) => Promise<string>;
  /** Checks whether node_modules exists (defaults to fs access). */
  hasModules?: (root: string) => Promise<boolean>;
  /** Sleep primitive for install pacing (defaults to setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

/** Options for {@link healProjectCompilation}. */
export interface CompileHealOptions extends CompileHealDeps {
  /** Max bounded repair turns (clamped to 0..4; default 2). */
  maxTurns?: number;
  /** Max files repaired per turn (default 3). */
  maxFilesPerTurn?: number;
  /** Status reporter (e.g. live spinner messages). */
  onStatus?: (message: string) => void;
}

/** Result of one compile-convergence run. */
export interface CompileHealResult {
  /** True when the project typechecks cleanly after the loop. */
  clean: boolean;
  /** True when healing was skipped (execution gate off, or nothing to do). */
  skipped: boolean;
  /** Project-relative files rewritten by repair turns. */
  repairedFiles: string[];
  /** Residual tsc diagnostics after the loop (empty when clean). */
  residualErrors: string[];
  /** Repair turns actually performed. */
  turns: number;
}

/** One parsed TypeScript compiler diagnostic. */
export interface TscDiagnostic {
  /** Project-relative file path (e.g. `src/pages/Home.tsx`). */
  file: string;
  /** Full single-line diagnostic text. */
  message: string;
}

/**
 * Parses `tsc` output lines of the form
 * `src/pages/Home.tsx(54,48): error TS2322: …` into per-file diagnostics.
 * Non-file lines (global errors, npm noise) are ignored; only safe
 * project-relative paths (`src/…`) become repair targets.
 */
export function parseTscDiagnostics(output: string): TscDiagnostic[] {
  const diagnostics: TscDiagnostic[] = [];
  for (const line of output.split('\n')) {
    const match = /^([^\s(][^()]*)\(\d+,\d+\):\s+error\s+(TS\d+):\s+(.*)$/.exec(line.trim());
    if (match === null) continue;
    const file = (match[1] ?? '').trim().replaceAll('\\', '/');
    if (!file.startsWith('src/') || file.includes('..')) continue;
    diagnostics.push({ file, message: line.trim() });
  }
  return diagnostics;
}

/** Groups diagnostics per file, keeping at most `maxErrors` per file. */
export function groupDiagnosticsByFile(
  diagnostics: readonly TscDiagnostic[],
  maxErrors: number = MAX_ERRORS_PER_FILE,
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const diagnostic of diagnostics) {
    const existing = grouped.get(diagnostic.file) ?? [];
    if (existing.length >= maxErrors) continue;
    existing.push(diagnostic.message);
    grouped.set(diagnostic.file, existing);
  }
  return grouped;
}

/** Default command runner: execFile with merged stdout/stderr. */
function defaultRun(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((done) => {
    execFile(command, args, { cwd, timeout: 300_000 }, (error, stdout, stderr) => {
      done({ ok: error === null, output: `${stdout}\n${stderr}` });
    });
  });
}

/** Default node_modules probe. */
async function defaultHasModules(root: string): Promise<boolean> {
  try {
    await access(join(root, 'node_modules'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the bounded compile-convergence loop over an emitted project.
 *
 * 1. Installs dependencies when `node_modules` is absent (pnpm, npm
 *    fallback — same order the verifier uses).
 * 2. Runs `tsc --noEmit`; on failure, repairs up to `maxFilesPerTurn`
 *    files per turn for at most `maxTurns` turns via `repairFile`.
 * 3. Stops early when the project typechecks cleanly.
 *
 * Residual errors are returned, never hidden: callers decide how a
 * non-converged project affects run status.
 */
export async function healProjectCompilation(
  projectDir: string,
  options: CompileHealOptions = {},
): Promise<CompileHealResult> {
  const root = resolve(projectDir);
  const run = options.run ?? defaultRun;
  const repairFile = options.repairFile ?? repairCodeFile;
  const hasModules = options.hasModules ?? defaultHasModules;
  const onStatus = options.onStatus ?? ((): void => undefined);
  const maxTurns = Number.isSafeInteger(options.maxTurns)
    ? Math.min(Math.max(options.maxTurns ?? DEFAULT_MAX_TURNS, 0), 4)
    : DEFAULT_MAX_TURNS;
  const maxFilesPerTurn = Math.max(1, options.maxFilesPerTurn ?? DEFAULT_MAX_FILES_PER_TURN);

  const empty: CompileHealResult = {
    clean: true,
    skipped: true,
    repairedFiles: [],
    residualErrors: [],
    turns: 0,
  };

  if (process.env.APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION !== '1') return empty;

  // Dependency install (mirrors the verifier's install order).
  if (!(await hasModules(root))) {
    onStatus('compile-heal: installing emitted-project dependencies');
    let ready = false;
    const install = await run('pnpm', ['install', '--prefer-offline', '--ignore-scripts'], root);
    ready = await hasModules(root);
    if (!ready) {
      const fallback = await run('npm', ['install', '--prefer-offline', '--ignore-scripts'], root);
      ready = await hasModules(root);
      if (!ready) {
        return {
          clean: false,
          skipped: false,
          repairedFiles: [],
          residualErrors: [
            'compile-heal could not install emitted-project dependencies:',
            install.output.trim().slice(-400),
            fallback.output.trim().slice(-400),
          ].filter((line) => line.length > 0),
          turns: 0,
        };
      }
    }
  }

  const tscArgs = ['--no-install', 'tsc', '--noEmit'];
  let tsc = await run('npx', tscArgs, root);
  if (tsc.ok) return { ...empty, skipped: false };

  const repairedFiles: string[] = [];
  let turns = 0;

  for (let turn = 0; turn < maxTurns && !tsc.ok; turn += 1) {
    const grouped = groupDiagnosticsByFile(parseTscDiagnostics(tsc.output));
    if (grouped.size === 0) break; // Unparseable output — never guess repair targets.
    turns += 1;
    onStatus(`compile-heal: repair turn ${turn + 1} (${grouped.size} file(s))`);

    let repairedThisTurn = 0;
    for (const [file, errors] of grouped) {
      if (repairedThisTurn >= maxFilesPerTurn) break;
      let content: string;
      try {
        content = await readFile(join(root, file), 'utf8');
      } catch {
        continue; // Diagnostic points at a missing file — skip.
      }
      try {
        const repaired = await repairFile(file, content, errors);
        if (repaired.length === 0 || repaired.length > 1_000_000) continue;
        await writeFile(join(root, file), repaired, 'utf8');
        if (!repairedFiles.includes(file)) repairedFiles.push(file);
        repairedThisTurn += 1;
      } catch {
        // A failed repair turn leaves the file untouched.
      }
    }
    if (repairedThisTurn === 0) break;

    tsc = await run('npx', tscArgs, root);
  }

  const residual = parseTscDiagnostics(tsc.output).map((diagnostic) => diagnostic.message);
  return {
    clean: tsc.ok,
    skipped: false,
    repairedFiles,
    residualErrors: tsc.ok ? [] : residual,
    turns,
  };
}
