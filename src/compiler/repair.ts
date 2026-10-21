/**
 * apograph — shared TypeScript compiler diagnostics + bounded repair loop.
 *
 * This is the single implementation of "run `tsc --noEmit`, group its
 * diagnostics per safe `src/…` file, and repair the worst offenders through
 * a bounded repair hook". Both self-healing consumers delegate here:
 *
 * - `synthesizer/compileHeal.ts` — synthesis-time compile convergence
 *   (before the verifier ever sees the emitted project);
 * - `verifier/engine.ts` — the tier-1 build's bounded compiler auto-repair.
 *
 * Duplicated parsing and repair-loop logic used to live in both; keeping one
 * implementation guarantees they can never drift apart on safety filtering,
 * turn bounds, or repair semantics.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One process run result (stdout+stderr merged by the caller's runner). */
export interface CommandResult {
  ok: boolean;
  output: string;
}

/** One parsed TypeScript compiler diagnostic. */
export interface CompilerDiagnostic {
  /** File path as printed by tsc (e.g. `src/components/Hero.tsx`). */
  file: string;
  /** 1-based line of the error. */
  line: number;
  /** 1-based column of the error. */
  column: number;
  /** Diagnostic code, e.g. `TS2322`. */
  code: string;
  /** Full diagnostic block text, including continuation lines. */
  message: string;
}

/** One file queued for a targeted repair turn. */
export interface RepairTarget {
  /** Project-relative file path (always `src/…`). */
  file: string;
  /** Diagnostic texts forwarded to the repair hook (bounded). */
  errors: string[];
}

/** Command runner seam shared by both self-healing consumers. */
export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<CommandResult>;

/** Repair hook seam (defaults to `repairCodeFile` at each call site). */
export type RepairHook = (
  filePath: string,
  currentContent: string,
  errors: string[],
) => Promise<string>;

// ---------------------------------------------------------------------------
// Diagnostic parsing (classic + pretty tsc formats)
// ---------------------------------------------------------------------------

/** Classic tsc format: `src/A.tsx(12,18): error TS2322: ...`. */
const TSC_ERROR_CLASSIC = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;

/** Pretty tsc format: `src/A.tsx:12:18 - error TS2322: ...`. */
const TSC_ERROR_PRETTY = /^(.+?):(\d+):(\d+)\s+-\s+error\s+(TS\d+):\s+(.*)$/;

/**
 * True when a diagnostic file is a safe in-project repair target: a
 * project-relative `src/…` path with no traversal segments and no
 * `node_modules`. Unsafe or external paths never reach the repair model.
 */
export function isRepairableSourcePath(file: string): boolean {
  const normalized = file.trim().replaceAll('\\', '/');
  return (
    normalized.startsWith('src/') &&
    !normalized.includes('..') &&
    !normalized.includes('node_modules')
  );
}

/**
 * Parses `tsc --noEmit` output into diagnostics, supporting both the classic
 * `file(line,col): error TSxxxx:` format and the pretty
 * `file:line:col - error TSxxxx:` format. Continuation lines (indented
 * message detail / code frames) fold into the owning diagnostic until the
 * next diagnostic or a blank line. File-less diagnostics (config-level
 * TS5xxx / TS6053) and unsafe paths (traversal, non-`src/`, `node_modules`)
 * produce no entries and are therefore never repair targets.
 */
export function parseTscDiagnostics(output: string): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  let current: CompilerDiagnostic | null = null;

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    const match = line.match(TSC_ERROR_CLASSIC) ?? line.match(TSC_ERROR_PRETTY);

    if (match !== null) {
      if (current !== null) diagnostics.push(current);
      current = {
        file: (match[1] as string).replaceAll('\\', '/'),
        line: Number.parseInt(match[2] as string, 10),
        column: Number.parseInt(match[3] as string, 10),
        code: match[4] as string,
        message: line,
      };
      continue;
    }

    if (current === null) continue;

    if (line.trim().length === 0) {
      diagnostics.push(current);
      current = null;
      continue;
    }

    current.message += `\n${line}`;
  }

  if (current !== null) diagnostics.push(current);
  return diagnostics.filter((diagnostic) => isRepairableSourcePath(diagnostic.file));
}

/** Default max diagnostics forwarded per repaired file (token bound). */
export const DEFAULT_MAX_ERRORS_PER_FILE = 20;

/** Groups diagnostics per file, keeping at most `maxErrors` per file. */
export function groupDiagnosticsByFile(
  diagnostics: readonly { file: string; message: string }[],
  maxErrors: number = DEFAULT_MAX_ERRORS_PER_FILE,
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

/** Groups parseable diagnostics into per-file repair targets (bounded). */
export function selectRepairTargets(
  diagnostics: readonly CompilerDiagnostic[],
  options: { maxFiles?: number; maxErrorsPerFile?: number } = {},
): RepairTarget[] {
  const maxFiles = Math.max(1, options.maxFiles ?? 3);
  const maxErrorsPerFile = Math.max(1, options.maxErrorsPerFile ?? DEFAULT_MAX_ERRORS_PER_FILE);
  return [...groupDiagnosticsByFile(diagnostics, maxErrorsPerFile).entries()]
    .slice(0, maxFiles)
    .map(([file, errors]) => ({ file, errors }));
}

// ---------------------------------------------------------------------------
// Deterministic truncation healing
// ---------------------------------------------------------------------------

/** tsc syntax-error codes that mark where a truncated emission broke. */
const TRUNCATION_SYNTAX_CODES = new Set([
  'TS1002',
  'TS1003',
  'TS1005',
  'TS1109',
  'TS1127',
  'TS1128',
]);

/** Safe single-token closers a `TS1005: '<x>' expected` can demand. */
const EXPECTED_TOKEN_CLOSERS = new Map<string, string>([
  ['}', '}'],
  [')', ')'],
  [']', ']'],
  [';', ';'],
  [',', ','],
]);

/**
 * Minimum fraction of the file the parse must reach before a syntax error is
 * treated as an end-of-emission break rather than a real mid-file bug.
 */
const TRUNCATION_TAIL_FRACTION = 0.75;

/**
 * Upper bound on deterministic truncation-healing rounds per repair loop:
 * one round closes the JSX stack, follow-up rounds append closers that only
 * surfaced after the previous reparse.
 */
const MAX_TRUNCATION_HEAL_ROUNDS = 3;

/** Maps a 1-based (line, column) diagnostic position to a string offset. */
function offsetAt(content: string, line: number, column: number): number {
  const lines = content.split('\n');
  const index = Math.min(Math.max(line, 1), lines.length) - 1;
  let offset = 0;
  for (let i = 0; i < index; i += 1) offset += (lines[i] as string).length + 1;
  return offset + Math.max(column - 1, 0);
}

/**
 * Deterministically completes an emission that was cut off mid-file.
 *
 * Truncation leaves a characteristic diagnostic shape: `TS17008` "JSX element
 * '<x>' has no corresponding closing tag" for every still-open element, plus
 * (sometimes) a syntax error where the parse ran off the end. The rewrite
 * excises the partial tail at the break point, closes the open JSX elements
 * in reverse opening order, and appends any explicitly expected closers
 * (`')' expected`, `'}' expected`) — turning a dropped completion into a
 * compilable file with its surviving content instead of abandoning the whole
 * page to a template.
 *
 * Returns null when the diagnostics are not truncation-shaped: real syntax
 * bugs in the middle of a file never trigger the rewrite.
 */
export function completeTruncatedSource(
  content: string,
  diagnostics: readonly CompilerDiagnostic[],
): string | null {
  const unclosed: Array<{ tag: string; offset: number }> = [];
  const expectedClosers: string[] = [];
  let breakOffset: number | null = null;

  for (const diagnostic of diagnostics) {
    const tagMatch = /JSX element '([^']+)' has no corresponding closing tag/.exec(
      diagnostic.message,
    );
    if (diagnostic.code === 'TS17008' && tagMatch !== null) {
      unclosed.push({
        tag: tagMatch[1] as string,
        offset: offsetAt(content, diagnostic.line, diagnostic.column),
      });
      continue;
    }
    if (!TRUNCATION_SYNTAX_CODES.has(diagnostic.code)) continue;
    const offset = offsetAt(content, diagnostic.line, diagnostic.column);
    if (breakOffset === null || offset < breakOffset) breakOffset = offset;
    const expected = /TS\d+: '([^']*)' expected/.exec(diagnostic.message);
    const closer = expected !== null ? EXPECTED_TOKEN_CLOSERS.get(expected[1] as string) : undefined;
    if (closer !== undefined && !expectedClosers.includes(closer)) expectedClosers.push(closer);
  }

  if (unclosed.length === 0 && breakOffset === null) return null;

  const lastUnclosedAt = unclosed.reduce((max, entry) => Math.max(max, entry.offset), 0);
  const tailStart = Math.floor(content.length * TRUNCATION_TAIL_FRACTION);
  if (unclosed.length === 0) {
    // No open JSX stack: a tail syntax error alone only justifies appending
    // explicitly expected closers — never cutting content away.
    if (breakOffset === null || breakOffset < tailStart || expectedClosers.length === 0) {
      return null;
    }
    return `${content.trimEnd()}\n${expectedClosers.join('\n')}`;
  }

  if (breakOffset !== null) {
    // A break before the open elements or before the tail is a real syntax
    // bug, not an end-of-emission cut — leave the file to the repair model.
    if (breakOffset < lastUnclosedAt || breakOffset < tailStart) return null;
  }

  let kept = content;
  if (breakOffset !== null) {
    kept = kept.slice(0, breakOffset);
    // Drop the partial line the break landed in.
    const lastNewline = kept.lastIndexOf('\n');
    kept = lastNewline === -1 ? '' : kept.slice(0, lastNewline + 1);
    kept = kept.replace(/\s+$/, '');
    if (kept.trim().length === 0) return null;
  }

  const closers = [...unclosed]
    .sort((a, b) => b.offset - a.offset)
    .map((entry) => `</${entry.tag}>`);
  let healed = kept;
  if (closers.length > 0) healed += `\n${closers.join('')}`;
  for (const closer of expectedClosers) healed += `\n${closer}`;
  return healed === content ? null : healed;
}

// ---------------------------------------------------------------------------
// Dependency installation (shared order: pnpm, then npm)
// ---------------------------------------------------------------------------

/** Outcome of the emitted-project dependency install probe. */
export interface DependencyInstallResult {
  /** True when `node_modules` materialized (or was already present). */
  ok: boolean;
  /** Outputs of the attempted install commands, in order. */
  attempts: CommandResult[];
}

/**
 * Installs emitted-project dependencies when `node_modules` is absent,
 * preferring pnpm and escalating to npm only when pnpm produced nothing.
 * Lifecycle scripts stay disabled (generated code never runs install hooks).
 */
export async function ensureProjectDependencies(
  root: string,
  run: CommandRunner,
  hasModules: (root: string) => Promise<boolean>,
): Promise<DependencyInstallResult> {
  if (await hasModules(root)) return { ok: true, attempts: [] };

  const attempts: CommandResult[] = [];
  attempts.push(await run('pnpm', ['install', '--prefer-offline', '--ignore-scripts'], root));
  if (await hasModules(root)) return { ok: true, attempts };

  attempts.push(await run('npm', ['install', '--prefer-offline', '--ignore-scripts'], root));
  return { ok: await hasModules(root), attempts };
}

// ---------------------------------------------------------------------------
// Bounded compiler repair loop
// ---------------------------------------------------------------------------

/** Options for {@link runCompilerRepairLoop}. */
export interface CompilerRepairLoopOptions {
  /** Command runner (injectable for tests). */
  run: CommandRunner;
  /** Repair hook (injectable for tests). */
  repairFile: RepairHook;
  /** Max bounded repair turns (0 disables the loop). */
  maxTurns?: number;
  /** Max files sent through repair per turn. */
  maxFilesPerTurn?: number;
  /** Max diagnostics forwarded per repaired file. */
  maxErrorsPerFile?: number;
  /** Status hook invoked at the start of each repair turn. */
  onTurn?: (turn: number, targets: RepairTarget[]) => void;
}

/** Result of one bounded compiler repair loop. */
export interface CompilerRepairLoopResult {
  /** Final `tsc --noEmit` result (after the last repair turn). */
  tsc: CommandResult;
  /** Project-relative files rewritten by repair turns (deduplicated). */
  repairedFiles: string[];
  /** Diagnostics forwarded for each successfully rewritten file. */
  errorsBefore: string[];
  /** Repair turns performed (0 when nothing repairable was found). */
  turns: number;
}

/**
 * Runs `tsc --noEmit` and repairs failing `src/…` sources through the
 * repair hook in bounded turns:
 *
 * 1. Initial `tsc --noEmit`; a clean typecheck returns immediately.
 * 2. Per turn: select up to `maxFilesPerTurn` failing files (each with at
 *    most `maxErrorsPerFile` diagnostics), repair, and rewrite on disk when
 *    the hook returns plausible content.
 * 3. Re-run `tsc` after each productive turn; stop early when no repair
 *    succeeded or no repairable diagnostics remain.
 *
 * Residual diagnostics are reported honestly via the final `tsc` result —
 * never hidden. The loop is always finite.
 */
export async function runCompilerRepairLoop(
  root: string,
  options: CompilerRepairLoopOptions,
): Promise<CompilerRepairLoopResult> {
  const tscArgs = ['--no-install', 'tsc', '--noEmit'];
  let tsc = await options.run('npx', tscArgs, root);

  const repairedFiles: string[] = [];
  const errorsBefore: string[] = [];
  const maxTurns = Number.isSafeInteger(options.maxTurns)
    ? Math.max(options.maxTurns ?? 0, 0)
    : 0;
  let turns = 0;

  // Deterministic truncation healing (bounded fixpoint, zero LLM cost): an
  // emission cut off mid-file is completed from its own diagnostics before a
  // repair turn is spent on it. Never counted as a repair turn — it only
  // rewrites files whose diagnostics are truncation-shaped.
  for (let round = 0; round < MAX_TRUNCATION_HEAL_ROUNDS && !tsc.ok; round += 1) {
    const byFile = new Map<string, CompilerDiagnostic[]>();
    for (const diagnostic of parseTscDiagnostics(tsc.output)) {
      const list = byFile.get(diagnostic.file) ?? [];
      list.push(diagnostic);
      byFile.set(diagnostic.file, list);
    }
    let healed = 0;
    for (const [file, fileDiagnostics] of byFile) {
      const filePath = join(root, file);
      let content: string;
      try {
        content = await readFile(filePath, 'utf8');
      } catch {
        continue; // Diagnostic points at a missing file — skip it.
      }
      const completed = completeTruncatedSource(content, fileDiagnostics);
      if (completed === null) continue;
      await writeFile(filePath, completed, 'utf8');
      if (!repairedFiles.includes(file)) repairedFiles.push(file);
      errorsBefore.push(...fileDiagnostics.map((diagnostic) => diagnostic.message));
      healed += 1;
    }
    if (healed === 0) break;
    tsc = await options.run('npx', tscArgs, root);
  }

  for (let turn = 0; turn < maxTurns && !tsc.ok; turn += 1) {
    const targets = selectRepairTargets(parseTscDiagnostics(tsc.output), {
      maxFiles: options.maxFilesPerTurn,
      maxErrorsPerFile: options.maxErrorsPerFile,
    });
    // Unparseable output — never guess repair targets.
    if (targets.length === 0) break;

    turns += 1;
    options.onTurn?.(turns, targets);

    let repairedThisTurn = 0;
    for (const target of targets) {
      const filePath = join(root, target.file);
      let content: string;
      try {
        content = await readFile(filePath, 'utf8');
      } catch {
        continue; // Diagnostic points at a missing file — skip it.
      }

      try {
        const repaired = await options.repairFile(target.file, content, target.errors);
        if (repaired.length === 0 || repaired.length > 1_000_000) continue;
        await writeFile(filePath, repaired, 'utf8');
        if (!repairedFiles.includes(target.file)) repairedFiles.push(target.file);
        errorsBefore.push(...target.errors);
        repairedThisTurn += 1;
      } catch {
        // A failed repair turn leaves the file untouched.
      }
    }
    // Nothing was rewritten — further turns would repeat the same work.
    if (repairedThisTurn === 0) break;

    tsc = await options.run('npx', tscArgs, root);
  }

  return { tsc, repairedFiles, errorsBefore, turns };
}
