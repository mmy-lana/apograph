/**
 * apograph — synthesis-time compile convergence (pre-verification
 * self-healing).
 *
 * Vision synthesis occasionally emits code that does not typecheck (e.g. a
 * malformed nested data literal passed inline into a typed JSX prop). A
 * generator that ships invalid TypeScript has already failed the emitted
 * project before verification starts — and residual type errors correlate
 * with runtime crashes the pixel score cannot reveal.
 *
 * This module closes the loop INSIDE the generation pipeline: after emit,
 * the project is typechecked and failing source files are repaired in
 * bounded turns until the project compiles or the budget is exhausted. The
 * tsc diagnostics parsing and the bounded repair loop itself are shared
 * with the verifier's tier-1 build repair (`src/compiler/repair.ts`) — this
 * module is the synthesis-time policy layer: execution gate, dependency
 * install, turn budget, and honest residual reporting.
 *
 * Policy: running generated-project tooling (dependency install, tsc)
 * requires `APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION=1`, mirroring the
 * verifier's own execution gate. When the gate is off, healing is skipped
 * and reported as such — the verifier then behaves exactly as configured.
 */

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { repairCodeFile } from './llm.js';
import {
  ensureProjectDependencies,
  groupDiagnosticsByFile as groupDiagnosticsByFileCore,
  parseTscDiagnostics as parseTscDiagnosticsCore,
  runCompilerRepairLoop,
} from '../compiler/repair.js';
import type { CommandResult, CompilerDiagnostic, RepairTarget } from '../compiler/repair.js';

export type { CommandResult, CompilerDiagnostic } from '../compiler/repair.js';

/** Default bounded repair turns (the loop is always finite). */
const DEFAULT_MAX_TURNS = 2;

/** Default max files sent through repair per turn (token bound). */
const DEFAULT_MAX_FILES_PER_TURN = 3;

/** Hard cap on diagnostics considered per file (token bound). */
const MAX_ERRORS_PER_FILE = 8;

/** Injectable collaborators (tests use deterministic fakes). */
export interface CompileHealDeps {
  /** Runs a command in the emitted project (defaults to execFile). */
  run?: (command: string, args: string[], cwd: string) => Promise<CommandResult>;
  /** Repair hook (defaults to `repairCodeFile`). */
  repairFile?: (filePath: string, content: string, errors: string[]) => Promise<string>;
  /** Checks whether node_modules exists (defaults to fs access). */
  hasModules?: (root: string) => Promise<boolean>;
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

/** One parsed TypeScript compiler diagnostic (file + message subset). */
export interface TscDiagnostic {
  /** Project-relative file path (e.g. `src/pages/Home.tsx`). */
  file: string;
  /** Full single-line diagnostic text. */
  message: string;
}

/**
 * Parses `tsc` output lines of the form
 * `src/pages/Home.tsx(54,48): error TS2322: …` into per-file diagnostics
 * via the shared parser (`src/compiler/repair.ts`): classic and pretty tsc
 * formats both fold into per-file entries, and only safe project-relative
 * `src/…` paths survive.
 */
export function parseTscDiagnostics(output: string): TscDiagnostic[] {
  return parseTscDiagnosticsCore(output).map(({ file, message }) => ({ file, message }));
}

/** Groups diagnostics per file, keeping at most `maxErrors` per file. */
export function groupDiagnosticsByFile(
  diagnostics: readonly TscDiagnostic[],
  maxErrors: number = MAX_ERRORS_PER_FILE,
): Map<string, string[]> {
  return groupDiagnosticsByFileCore(diagnostics, maxErrors);
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
 *    fallback — the shared install order the verifier also uses).
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

  // Dependency install (shared order: pnpm, then npm). Announce the first
  // missing-modules probe so the live spinner reflects the install.
  let announcedInstall = false;
  const trackedHasModules = async (probeRoot: string): Promise<boolean> => {
    const ready = await hasModules(probeRoot);
    if (!ready && !announcedInstall) {
      announcedInstall = true;
      onStatus('compile-heal: installing emitted-project dependencies');
    }
    return ready;
  };
  const install = await ensureProjectDependencies(root, run, trackedHasModules);
  if (!install.ok) {
    return {
      clean: false,
      skipped: false,
      repairedFiles: [],
      residualErrors: [
        'compile-heal could not install emitted-project dependencies:',
        ...install.attempts.map((attempt) => attempt.output.trim().slice(-400)),
      ].filter((line) => line.length > 0),
      turns: 0,
    };
  }

  const healed = await runCompilerRepairLoop(root, {
    run,
    repairFile,
    maxTurns,
    maxFilesPerTurn,
    maxErrorsPerFile: MAX_ERRORS_PER_FILE,
    onTurn: (turn: number, targets: RepairTarget[]) => {
      onStatus(`compile-heal: repair turn ${turn} (${targets.length} file(s))`);
    },
  });

  const residual = parseTscDiagnostics(healed.tsc.output).map((diagnostic) => diagnostic.message);
  return {
    clean: healed.tsc.ok,
    skipped: false,
    repairedFiles: healed.repairedFiles,
    residualErrors: healed.tsc.ok ? [] : residual,
    turns: healed.turns,
  };
}
