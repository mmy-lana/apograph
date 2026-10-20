/**
 * Regression tests for synthesis-time compile convergence
 * (remediation record: pre-verification self-healing).
 *
 * The loop typechecks an emitted project and repairs failing sources through
 * a bounded repair hook before the verifier ever sees the project — so the
 * generator cannot ship known-invalid TypeScript (whose residual type errors
 * correlate with runtime crashes the pixel score cannot reveal).
 *
 * All fixtures are generic (`src/pages/Example.tsx`); the runner and repair
 * hook are injected fakes — no LLM, no network, no real tsc.
 *
 * spec: automate-testing-self-fixing.md, Session 2 — Attempt 1 remediation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  healProjectCompilation,
  parseTscDiagnostics,
  groupDiagnosticsByFile,
  type CommandResult,
} from '../dist/synthesizer/compileHeal.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TSC_ERROR_LINES = [
  "src/pages/Example.tsx(54,48): error TS2322: Type 'readonly [\"\", readonly [\"A\"]]' is not assignable to type 'string'.",
  "src/pages/Example.tsx(57,281): error TS2322: Type 'string | string[]' is not assignable to type 'Key'.",
  "src/pages/Other.tsx(10,3): error TS2339: Property 'map' does not exist on type 'never'.",
].join('\n');

/** Temp project with one source file and a fake node_modules marker. */
async function withProject(
  run: (root: string, sourceFile: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'apograph-compile-heal-'));
  try {
    await mkdir(join(root, 'src', 'pages'), { recursive: true });
    await mkdir(join(root, 'node_modules'), { recursive: true });
    const sourceFile = join(root, 'src', 'pages', 'Example.tsx');
    await writeFile(sourceFile, 'export const broken = true\n', 'utf8');
    await writeFile(join(root, 'src', 'pages', 'Other.tsx'), 'export const also = true\n', 'utf8');
    await run(root, sourceFile);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Scripted command runner: consumes tsc results in order; installs succeed. */
function scriptedRunner(tscOutputs: Array<{ ok: boolean; output: string }>): {
  run: (command: string, args: string[], cwd: string) => Promise<CommandResult>;
  calls: string[][];
} {
  const calls: string[][] = [];
  let tscIndex = 0;
  return {
    calls,
    run: async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (args.includes('install')) return { ok: true, output: 'installed' };
      const next = tscOutputs[tscIndex] ?? tscOutputs[tscOutputs.length - 1];
      tscIndex += 1;
      return next ?? { ok: true, output: '' };
    },
  };
}

/** Sets the execution gate for one test and restores it afterwards. */
async function withExecGate(run: () => Promise<void>): Promise<void> {
  const previous = process.env.APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION;
  process.env.APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION = '1';
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION;
    else process.env.APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION = previous;
  }
}

// ---------------------------------------------------------------------------
// Diagnostics parsing
// ---------------------------------------------------------------------------

test('compile-heal > parseTscDiagnostics extracts file-scoped error lines', () => {
  const diagnostics = parseTscDiagnostics(TSC_ERROR_LINES);
  assert.equal(diagnostics.length, 3);
  assert.equal(diagnostics[0]?.file, 'src/pages/Example.tsx');
  assert.ok(diagnostics[0]?.message.includes('TS2322'));
});

test('compile-heal > parseTscDiagnostics ignores noise and unsafe paths', () => {
  const noise = [
    'npm warn deprecated something',
    'global error TS6053: file not found',
    '../escape.ts(1,1): error TS1005: bad',
    'src/../../evil.ts(1,1): error TS1005: bad',
    'lib/Outside.tsx(2,2): error TS2322: not under src/',
  ].join('\n');
  assert.deepEqual(parseTscDiagnostics(noise), []);
});

test('compile-heal > groupDiagnosticsByFile groups and caps per file', () => {
  const grouped = groupDiagnosticsByFile(parseTscDiagnostics(TSC_ERROR_LINES), 1);
  assert.equal(grouped.size, 2);
  assert.equal(grouped.get('src/pages/Example.tsx')?.length, 1, 'per-file cap respected');
  assert.equal(grouped.get('src/pages/Other.tsx')?.length, 1);
});

// ---------------------------------------------------------------------------
// Healing loop
// ---------------------------------------------------------------------------

test('compile-heal > clean typecheck short-circuits without repairs', async () => {
  await withProject(async (root) => {
    await withExecGate(async () => {
      const { run, calls } = scriptedRunner([{ ok: true, output: '' }]);
      let repairs = 0;
      const result = await healProjectCompilation(root, {
        run,
        repairFile: async () => {
          repairs += 1;
          return '';
        },
      });
      assert.equal(result.clean, true);
      assert.equal(result.skipped, false);
      assert.equal(result.turns, 0);
      assert.deepEqual(result.repairedFiles, []);
      assert.equal(repairs, 0);
      assert.ok(calls.some((c) => c.includes('tsc')));
    });
  });
});

test('compile-heal > one repair turn converges and rewrites the file on disk', async () => {
  await withProject(async (root, sourceFile) => {
    await withExecGate(async () => {
      const { run } = scriptedRunner([
        { ok: false, output: TSC_ERROR_LINES },
        { ok: true, output: '' },
      ]);
      const seen: Array<{ file: string; errors: string[] }> = [];
      const result = await healProjectCompilation(root, {
        run,
        repairFile: async (file, _content, errors) => {
          seen.push({ file, errors });
          return 'export const fixed = true\n';
        },
      });
      assert.equal(result.clean, true);
      assert.equal(result.turns, 1);
      assert.deepEqual(result.repairedFiles, ['src/pages/Example.tsx', 'src/pages/Other.tsx']);
      assert.ok(seen.length >= 1);
      assert.ok(seen[0]!.errors.length >= 1, 'repair receives its file diagnostics');
      assert.equal(await readFile(sourceFile, 'utf8'), 'export const fixed = true\n');
    });
  });
});

test('compile-heal > loop is bounded and reports residual errors honestly', async () => {
  await withProject(async (root) => {
    await withExecGate(async () => {
      const { run } = scriptedRunner([{ ok: false, output: TSC_ERROR_LINES }]);
      let repairs = 0;
      const result = await healProjectCompilation(root, {
        run,
        maxTurns: 2,
        maxFilesPerTurn: 3,
        repairFile: async () => {
          repairs += 1;
          return 'export const stillBroken = true\n';
        },
      });
      assert.equal(result.clean, false, 'persistent errors never reported clean');
      assert.ok(result.turns <= 2, `turns bounded (got ${result.turns})`);
      assert.equal(repairs, 4, '2 turns x 2 failing files, no unbounded retries');
      assert.ok(result.residualErrors.length > 0, 'residual diagnostics surfaced');
    });
  });
});

test('compile-heal > unparseable tsc output triggers no repair guesses', async () => {
  await withProject(async (root) => {
    await withExecGate(async () => {
      const { run } = scriptedRunner([
        { ok: false, output: 'something exploded in an unparseable way' },
        { ok: false, output: 'something exploded in an unparseable way' },
      ]);
      let repairs = 0;
      const result = await healProjectCompilation(root, {
        run,
        repairFile: async () => {
          repairs += 1;
          return 'x';
        },
      });
      assert.equal(repairs, 0);
      assert.equal(result.clean, false);
      assert.equal(result.turns, 0);
    });
  });
});

test('compile-heal > skipped entirely when the execution gate is off', async () => {
  await withProject(async (root) => {
    const previous = process.env.APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION;
    delete process.env.APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION;
    try {
      const { run, calls } = scriptedRunner([{ ok: true, output: '' }]);
      const result = await healProjectCompilation(root, {
        run,
        repairFile: async () => 'x',
      });
      assert.equal(result.skipped, true);
      assert.equal(calls.length, 0, 'no generated-project execution without the gate');
    } finally {
      if (previous !== undefined) process.env.APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION = previous;
    }
  });
});

test('compile-heal > installs dependencies first when node_modules is absent', async () => {
  await withProject(async (root) => {
    await withExecGate(async () => {
      const { run, calls } = scriptedRunner([{ ok: true, output: '' }]);
      let modules = false;
      const result = await healProjectCompilation(root, {
        run,
        hasModules: async () => {
          if (modules) return true;
          modules = true; // materialized by the install call below
          return false;
        },
        repairFile: async () => 'x',
      });
      assert.equal(result.clean, true);
      assert.ok(
        calls.some((c) => c[0] === 'pnpm' && c.includes('install')),
        'pnpm install runs before typechecking',
      );
    });
  });
});
