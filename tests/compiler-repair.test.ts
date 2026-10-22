/**
 * Compiler auto-repair loop tests (tier 1 resilience).
 *
 * Covers `parseTscDiagnostics` (classic + pretty tsc formats), repair-target
 * filtering (config errors, node_modules, path traversal), and the bounded
 * single-turn repair loop inside `runTier1Build` — including the guarantee
 * that `vite build` runs even when residual tsc errors remain so `dist/` is
 * produced for the route/visual tiers.
 *
 * All loop tests run against mocked `Tier1Deps` seams: no real tsc, vite,
 * pnpm, or LLM is invoked.
 *
 * spec: docs/compiler-auto-repair-patch-plan.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { parseTscDiagnostics, runTier1Build } from '../dist/verifier/engine.js';
import type { CommandResult, Tier1Deps } from '../dist/verifier/engine.js';
import { completeTruncatedSource, runCompilerRepairLoop, parseImportClauseForSpecifier, buildMissingModuleStub } from '../dist/compiler/repair.js';

// ---------------------------------------------------------------------------
// Fixtures & harness
// ---------------------------------------------------------------------------

/** Classic-format TS2322 (the Lucide icon vs ReactNode quirk). */
const CLASSIC_TS2322 = [
  "src/components/Hero.tsx(12,18): error TS2322: Type 'ForwardRefExoticComponent<...>' is not assignable to type 'ReactNode'.",
  "  Type 'ForwardRefExoticComponent<...>' provides no match for the property 'children'.",
].join('\n');

interface RecordedCall {
  command: string;
  args: string[];
  cwd: string;
}

interface RepairCall {
  filePath: string;
  currentContent: string;
  errors: string[];
}

interface HarnessOptions {
  /** Consumed one per `tsc` invocation; over-invocation is a test failure. */
  tscResults: CommandResult[];
  viteResult?: CommandResult;
  installResult?: CommandResult;
  repair?: (filePath: string, currentContent: string, errors: string[]) => string;
}

/** Builds mocked Tier1Deps recording every command and repair call. */
function makeDeps(options: HarnessOptions): {
  deps: Tier1Deps;
  calls: RecordedCall[];
  repairs: RepairCall[];
} {
  const calls: RecordedCall[] = [];
  const repairs: RepairCall[] = [];
  const tscQueue = [...options.tscResults];

  const deps: Tier1Deps = {
    run: async (command, args, cwd) => {
      calls.push({ command, args, cwd });
      if (command === 'pnpm' || command === 'npm') {
        return options.installResult ?? { ok: true, output: '' };
      }
      if (args.includes('tsc')) {
        const next = tscQueue.shift();
        assert.ok(next !== undefined, `unexpected tsc invocation #${calls.length}`);
        return next;
      }
      return options.viteResult ?? { ok: true, output: '' };
    },
    repairFile: async (filePath, currentContent, errors) => {
      repairs.push({ filePath, currentContent, errors });
      return options.repair !== undefined
        ? options.repair(filePath, currentContent, errors)
        : currentContent;
    },
  };

  return { deps, calls, repairs };
}

/** Creates a throwaway emitted-project directory (optionally with node_modules). */
async function makeProject(
  files: Record<string, string>,
  withModules = true,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'apograph-compiler-repair-'));
  if (withModules) await mkdir(join(dir, 'node_modules'));
  for (const [path, content] of Object.entries(files)) {
    const filePath = join(dir, path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Tests 5–7: diagnostic parsing & repair-target filtering
// ---------------------------------------------------------------------------

test('tsc parse > extracts file, position, and code from classic diagnostics', () => {
  const diagnostics = parseTscDiagnostics(CLASSIC_TS2322);
  assert.equal(diagnostics.length, 1);

  const diagnostic = diagnostics[0];
  assert.ok(diagnostic !== undefined);
  assert.equal(diagnostic.file, 'src/components/Hero.tsx');
  assert.equal(diagnostic.line, 12);
  assert.equal(diagnostic.column, 18);
  assert.equal(diagnostic.code, 'TS2322');
  assert.ok(
    diagnostic.message.includes("provides no match for the property 'children'"),
    'continuation lines must fold into the owning diagnostic',
  );
});

test('tsc parse > extracts pretty-format diagnostics', () => {
  const diagnostics = parseTscDiagnostics(
    "src/App.tsx:4:9 - error TS2304: Cannot find name 'x'.",
  );
  assert.equal(diagnostics.length, 1);

  const diagnostic = diagnostics[0];
  assert.ok(diagnostic !== undefined);
  assert.equal(diagnostic.file, 'src/App.tsx');
  assert.equal(diagnostic.line, 4);
  assert.equal(diagnostic.column, 9);
  assert.equal(diagnostic.code, 'TS2304');
});

test('tsc parse > non-file and out-of-src diagnostics are not repair targets', async () => {
  // File-less config errors produce no diagnostics at all.
  const configOutput = [
    "error TS5023: Unknown compiler option 'strictPort'.",
    "error TS6053: File 'tsconfig.json' not found.",
  ].join('\n');
  assert.equal(parseTscDiagnostics(configOutput).length, 0);

  // node_modules diagnostics parse, but are never sent to the repair model.
  const project = await makeProject({ 'src/App.tsx': 'export {};\n' });
  try {
    const { deps, repairs, calls } = makeDeps({
      tscResults: [
        {
          ok: false,
          output: 'node_modules/foo/index.d.ts(3,1): error TS2322: broken.',
        },
      ],
    });
    const build = await runTier1Build(project, deps);

    assert.equal(repairs.length, 0);
    assert.equal(build.typecheckBypassed, true);
    assert.equal(build.vitePassed, true);
    assert.ok(calls.some((call) => call.args.includes('vite')));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests 8–13: the bounded compiler auto-repair loop
// ---------------------------------------------------------------------------

test('build repair > one repair turn fixes tsc and vite build proceeds', async () => {
  const project = await makeProject({
    'src/components/Hero.tsx': 'export const icon = <Shield className="w-4" />;\n',
  });
  try {
    const { deps, calls, repairs } = makeDeps({
      tscResults: [
        { ok: false, output: CLASSIC_TS2322 },
        { ok: true, output: '' },
      ],
      repair: () => 'export const icon: ReactNode = <Shield className="w-4" />;\n',
    });
    const build = await runTier1Build(project, deps);

    // Exactly one targeted repair call, carrying the TS2322 diagnostics.
    assert.equal(repairs.length, 1);
    assert.equal(repairs[0]?.filePath, 'src/components/Hero.tsx');
    assert.ok((repairs[0]?.errors ?? []).some((error) => error.includes('TS2322')));

    // The repaired content was written back to disk.
    const rewritten = await readFile(
      join(project, 'src/components/Hero.tsx'),
      'utf8',
    );
    assert.ok(rewritten.includes('ReactNode'));

    assert.equal(build.tscPassed, true);
    assert.equal(build.vitePassed, true);
    assert.equal(build.success, true);
    assert.equal(build.repair?.fixed, true);
    assert.deepEqual(build.repair?.repairedFiles, ['src/components/Hero.tsx']);
    assert.ok((build.repair?.errorsBefore ?? []).some((line) => line.includes('TS2322')));
    assert.equal(build.typecheckBypassed, undefined);

    // tsc ran twice (initial + re-run); vite build ran once.
    assert.equal(calls.filter((call) => call.args.includes('tsc')).length, 2);
    assert.ok(calls.some((call) => call.args.includes('vite')));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('build repair > residual tsc errors still force vite build', async () => {
  const project = await makeProject({
    'src/components/Hero.tsx': 'export const icon = <Shield className="w-4" />;\n',
  });
  try {
    const { deps, calls, repairs } = makeDeps({
      tscResults: [
        { ok: false, output: CLASSIC_TS2322 },
        { ok: false, output: CLASSIC_TS2322 },
      ],
      repair: () => 'export const icon = <Shield />; // still broken\n',
    });
    const build = await runTier1Build(project, deps);

    assert.equal(repairs.length, 1);
    assert.ok(
      calls.some((call) => call.args.includes('vite')),
      'vite build must run despite residual tsc errors',
    );
    assert.equal(build.tscPassed, false);
    assert.equal(build.vitePassed, true);
    assert.equal(build.success, false);
    assert.equal(build.typecheckBypassed, true);
    assert.equal(build.repair?.fixed, false);
    assert.ok(
      build.errors.some((line) => line.includes('TS2322')),
      'residual diagnostics must be retained in errors',
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('build repair > repair turn is bounded', async () => {
  // Four failing files: only the first three reach the repair model, and the
  // tsc re-run happens exactly once.
  const output = ['a', 'b', 'c', 'd']
    .map((name) => `src/components/${name}.tsx(1,1): error TS2322: broken.`)
    .join('\n');
  const files = Object.fromEntries(
    ['a', 'b', 'c', 'd'].map((name) => [
      `src/components/${name}.tsx`,
      `export const ${name} = 1;\n`,
    ]),
  );
  const project = await makeProject(files);
  try {
    const { deps, calls, repairs } = makeDeps({
      tscResults: [
        { ok: false, output },
        { ok: false, output },
      ],
      repair: (filePath) => `// touched ${filePath}\n`,
    });
    const build = await runTier1Build(project, deps);

    assert.equal(repairs.length, 3, 'at most 3 files per repair turn');
    assert.equal(new Set(repairs.map((repair) => repair.filePath)).size, 3, 'never twice per file');
    assert.ok(!repairs.some((repair) => repair.filePath === 'src/components/d.tsx'));

    const tscCalls = calls.filter((call) => call.args.includes('tsc'));
    assert.equal(tscCalls.length, 2, 'exactly one tsc re-run');
    assert.equal(build.repair?.fixed, false);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('build repair > unparseable tsc output skips repair but still builds', async () => {
  const project = await makeProject({ 'src/App.tsx': 'export {};\n' });
  try {
    const { deps, calls, repairs } = makeDeps({
      tscResults: [{ ok: false, output: 'tsc crashed: something went wrong' }],
    });
    const build = await runTier1Build(project, deps);

    assert.equal(repairs.length, 0);
    assert.equal(build.repair, undefined);
    assert.ok(calls.some((call) => call.args.includes('vite')));
    assert.equal(build.vitePassed, true);
    assert.equal(build.success, false);
    assert.equal(build.typecheckBypassed, true);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('build repair > install failure keeps the legacy early return', async () => {
  const project = await makeProject({}, false);
  try {
    const { deps, calls, repairs } = makeDeps({
      tscResults: [],
      installResult: { ok: false, output: 'ERR_PNPM_NO_MATCHING_VERSION' },
    });
    const build = await runTier1Build(project, deps);

    assert.equal(build.success, false);
    assert.equal(build.tscPassed, false);
    assert.equal(build.vitePassed, false);
    assert.equal(build.repair, undefined);
    assert.equal(repairs.length, 0);
    assert.ok(build.errors[0]?.includes('Failed to install dependencies'));
    assert.ok(
      calls.filter((call) => call.command === 'pnpm' || call.command === 'npm')
        .every((call) => call.args.includes('--ignore-scripts')),
      'dependency installation must disable lifecycle scripts',
    );
    assert.equal(
      calls.filter((call) => call.args.includes('tsc') || call.args.includes('vite')).length,
      0,
      'tsc/vite must not run after an install failure',
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('build repair > path traversal diagnostics are ignored', async () => {
  const project = await makeProject({ 'src/App.tsx': 'export {};\n' });
  try {
    const output = [
      '../outside.ts(1,1): error TS2322: broken.',
      'src/../../outside.ts(1,1): error TS2322: broken.',
    ].join('\n');
    const { deps, repairs } = makeDeps({
      tscResults: [{ ok: false, output }],
    });
    await runTier1Build(project, deps);

    assert.equal(repairs.length, 0, 'out-of-project files must never be repaired');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Deterministic truncation healing
// ---------------------------------------------------------------------------

/** A page emission cut off mid-JSX at the end of the file. */
const TRUNCATED_PAGE = [
  'export function HomePage() {',
  '  return (',
  '    <main className="page">',
  '      <section className="hero">',
  '        <h1>Welcome to the page',
].join('\n');

/** tsc diagnostics for {@link TRUNCATED_PAGE} (unclosed stack + tail break). */
const TRUNCATED_PAGE_ERRORS = [
  'src/pages/HomePage.tsx(3,5): error TS17008: JSX element \'main\' has no corresponding closing tag.',
  'src/pages/HomePage.tsx(4,7): error TS17008: JSX element \'section\' has no corresponding closing tag.',
  'src/pages/HomePage.tsx(5,9): error TS17008: JSX element \'h1\' has no corresponding closing tag.',
  "src/pages/HomePage.tsx(5,30): error TS1005: '</' expected.",
].join('\n');

test('truncation heal > closes the JSX stack of an emission cut off mid-file', () => {
  const healed = completeTruncatedSource(
    TRUNCATED_PAGE,
    parseTscDiagnostics(TRUNCATED_PAGE_ERRORS),
  );
  assert.equal(
    healed,
    [
      'export function HomePage() {',
      '  return (',
      '    <main className="page">',
      '      <section className="hero">',
      '</h1></section></main>',
    ].join('\n'),
  );
});

test('truncation heal > appends explicitly expected closers at EOF', () => {
  const content = ['export function App() {', '  return (', '    <main />', '  );', ''].join('\n');
  const healed = completeTruncatedSource(
    content,
    parseTscDiagnostics("src/App.tsx(5,1): error TS1005: '}' expected."),
  );
  assert.equal(healed, `${content.trimEnd()}\n}`);
});

test('truncation heal > only TS17008 (no break) appends closers without cutting', () => {
  const content = ['export function App() {', '  return (', '    <main>'].join('\n');
  const healed = completeTruncatedSource(
    content,
    parseTscDiagnostics(
      "src/App.tsx(3,5): error TS17008: JSX element 'main' has no corresponding closing tag.",
    ),
  );
  assert.equal(healed, `${content}\n</main>`);
});

test('truncation heal > real mid-file syntax bugs are never rewritten', () => {
  // A syntax break in the first quarter of the file is a genuine bug, not an
  // end-of-emission cut.
  const content = [
    'export function App() {',
    '  return ( <main />',
    '  );',
    ...Array.from({ length: 12 }, (_, index) => `  const pad${index} = ${index};`),
    '}',
  ].join('\n');
  const healed = completeTruncatedSource(
    content,
    parseTscDiagnostics("src/App.tsx(2,18): error TS1005: ')' expected."),
  );
  assert.equal(healed, null);

  // Pure type errors are not truncation-shaped at all.
  assert.equal(
    completeTruncatedSource(content, parseTscDiagnostics(CLASSIC_TS2322)),
    null,
  );
});

test('truncation heal > repair loop completes truncated files without LLM turns', async () => {
  const project = await makeProject({ 'src/pages/HomePage.tsx': `${TRUNCATED_PAGE}\n` });
  try {
    const tscQueue: CommandResult[] = [
      { ok: false, output: TRUNCATED_PAGE_ERRORS },
      {
        ok: false,
        output: [
          "src/pages/HomePage.tsx(6,1): error TS1005: ')' expected.",
          "src/pages/HomePage.tsx(6,2): error TS1005: '}' expected.",
        ].join('\n'),
      },
      { ok: true, output: '' },
    ];
    const repairs: string[] = [];
    const result = await runCompilerRepairLoop(project, {
      run: async (_command, args) => {
        assert.ok(args.includes('tsc'));
        const next = tscQueue.shift();
        assert.ok(next !== undefined, 'unexpected tsc invocation');
        return next;
      },
      repairFile: async (filePath) => {
        repairs.push(filePath);
        return '';
      },
      maxTurns: 2,
    });

    assert.deepEqual(repairs, [], 'deterministic healing must not spend LLM turns');
    assert.equal(result.turns, 0);
    assert.ok(result.tsc.ok);
    const healed = await readFile(join(project, 'src/pages/HomePage.tsx'), 'utf8');
    assert.equal(
      healed,
      [
        'export function HomePage() {',
        '  return (',
        '    <main className="page">',
        '      <section className="hero">',
        '</h1></section></main>',
        ')',
        '}',
      ].join('\n'),
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Missing relative-module stubs
// ---------------------------------------------------------------------------

test('module stubs > parseImportClauseForSpecifier extracts default and named bindings', () => {
  const content = [
    "import type { FooterLink, Brand as BrandModel } from './types';",
    "import Icon from './types';",
    "import { Other } from './elsewhere';",
  ].join('\n');
  const imports = parseImportClauseForSpecifier(content, './types');
  assert.ok(imports !== null);
  assert.equal(imports.defaultName, 'Icon');
  assert.deepEqual(imports.named, ['FooterLink', 'BrandModel'], 'aliases resolve to local names');
  assert.equal(parseImportClauseForSpecifier(content, './missing'), null);
});

test('module stubs > buildMissingModuleStub emits class stubs for every binding', () => {
  const stub = buildMissingModuleStub({ defaultName: 'Icon', named: ['FooterLink'] });
  assert.equal(stub, 'export class FooterLink {}\nexport default class Icon {}\n');
  assert.equal(buildMissingModuleStub({ named: [] }), null);
});

test('module stubs > repair loop creates the missing module without LLM turns', async () => {
  const project = await makeProject({
    'src/components/Footer.tsx': [
      "import type { FooterLink } from './types';",
      "import Icon from './types';",
      'export function Footer(links: FooterLink[]): null {',
      '  void links; void Icon; return null;',
      '}',
    ].join('\n'),
  });
  try {
    const tscQueue: CommandResult[] = [
      {
        ok: false,
        output: "src/components/Footer.tsx(1,24): error TS2307: Cannot find module './types' or its corresponding type declarations.",
      },
      { ok: true, output: '' },
    ];
    const repairs: string[] = [];
    const result = await runCompilerRepairLoop(project, {
      run: async (_command, args) => {
        assert.ok(args.includes('tsc'));
        const next = tscQueue.shift();
        assert.ok(next !== undefined, 'unexpected tsc invocation');
        return next;
      },
      repairFile: async (filePath) => {
        repairs.push(filePath);
        return '';
      },
      maxTurns: 2,
    });

    assert.deepEqual(repairs, [], 'stub creation must not spend LLM turns');
    assert.ok(result.tsc.ok);
    const stub = await readFile(join(project, 'src/components/types.ts'), 'utf8');
    assert.equal(stub, 'export class FooterLink {}\nexport default class Icon {}\n');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
