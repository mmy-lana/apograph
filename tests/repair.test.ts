/**
 * Unit tests for the single-turn closed-loop visual diff repair pass.
 *
 * spec: integration/visual-resilience s8.5 (repair > single-turn repair
 * re-enters verification)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';

import { runVisualRepairPass } from '../dist/verifier/engine.js';
import { buildVisualRepairPrompt } from '../dist/synthesizer/vision.js';
import type { VisualCheck } from '../dist/verifier/report.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A tiny valid PNG buffer. */
function tinyPng(): Buffer {
  const png = new PNG({ width: 4, height: 4 });
  png.data.fill(128);
  return PNG.sync.write(png);
}

function visualCheck(
  path: string,
  viewport: 'desktop' | 'mobile',
  mismatchPercent: number | null,
  passed: boolean | null,
  referenceScreenshot: string | null,
  diffImage: string | null,
): VisualCheck {
  return {
    path,
    viewport,
    referenceScreenshot,
    diffImage,
    mismatchPercent,
    thresholdPercent: 15,
    passed,
  };
}

async function makeFixtures(): Promise<{
  outputDir: string;
  evidenceDir: string;
  reference: string;
  diff: string;
}> {
  const outputDir = await mkdtemp(join(tmpdir(), 'apograph-repair-out-'));
  const evidenceDir = await mkdtemp(join(tmpdir(), 'apograph-repair-ev-'));
  await mkdir(join(outputDir, 'src', 'pages'), { recursive: true });

  await writeFile(
    join(outputDir, 'src', 'pages', 'HomePage.tsx'),
    'export function HomePage() {\n  return <div>before</div>;\n}\n',
    'utf8',
  );

  const reference = join(evidenceDir, 'reference.png');
  const diff = join(evidenceDir, 'diff.png');
  await writeFile(reference, tinyPng());
  await writeFile(diff, tinyPng());

  return { outputDir, evidenceDir, reference, diff };
}

/** Cleans up both fixture directories. */
async function cleanup(fixtures: { outputDir: string; evidenceDir: string }): Promise<void> {
  await rm(fixtures.outputDir, { recursive: true, force: true });
  await rm(fixtures.evidenceDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// s8.5 - repair > single-turn repair re-enters verification
// ---------------------------------------------------------------------------

test('repair > single-turn repair re-enters verification', async () => {
  const fixtures = await makeFixtures();
  const { outputDir, reference, diff } = fixtures;
  try {
    const calls: Array<{
      componentPath: string;
      currentCode: string;
      original: string;
      diffOverlay: string;
      mismatch: number;
    }> = [];
    let rebuildCount = 0;
    let reVerifyCount = 0;

    const visuals = [
      visualCheck('/en', 'desktop', 30, false, reference, diff),
      visualCheck('/en', 'mobile', 22, false, reference, diff),
      visualCheck('/en/about', 'desktop', 4, true, reference, diff),
    ];

    const { visuals: repaired, repairs } = await runVisualRepairPass({
      visuals,
      componentPathsByRoute: new Map([['/en', 'src/pages/HomePage.tsx']]),
      outputDir,
      repairComponent: async (componentPath, currentCode, original, diffOverlay, mismatch) => {
        calls.push({ componentPath, currentCode, original, diffOverlay, mismatch });
        return 'export function HomePage() {\n  return <div>repaired</div>;\n}\n';
      },
      rebuild: async () => {
        rebuildCount += 1;
        return true;
      },
      reVerify: async () => {
        reVerifyCount += 1;
        return [
          visualCheck('/en', 'desktop', 5, true, reference, diff),
          visualCheck('/en', 'mobile', 8, true, reference, diff),
        ];
      },
    });

    // Exactly one repair turn for the failing route (both viewports, one turn).
    assert.equal(calls.length, 1);
    assert.equal(rebuildCount, 1);
    assert.equal(reVerifyCount, 1);

    // The repair prompt names the failing component and its current code.
    assert.ok(calls[0]?.componentPath.endsWith('HomePage.tsx'));
    assert.ok(calls[0]?.currentCode.includes('before'));

    // The reference screenshot and the pixelmatch diff overlay are embedded
    // as image parts (base64 data URLs).
    assert.match(calls[0]?.original ?? '', /^data:image\/png;base64,/);
    assert.match(calls[0]?.diffOverlay ?? '', /^data:image\/png;base64,/);

    // The worst failing viewport drove the repair (30%, not 22%).
    assert.equal(calls[0]?.mismatch, 30);

    // The repaired component was written to disk.
    const onDisk = await readFile(join(outputDir, 'src', 'pages', 'HomePage.tsx'), 'utf8');
    assert.ok(onDisk.includes('repaired'));

    // Outcomes recorded: before/after metrics and fixed flags.
    assert.equal(repairs.length, 2);
    const desktop = repairs.find((entry) => entry.viewport === 'desktop');
    const mobile = repairs.find((entry) => entry.viewport === 'mobile');
    assert.deepEqual(desktop, { path: '/en', viewport: 'desktop', mismatchBefore: 30, mismatchAfter: 5, fixed: true });
    assert.deepEqual(mobile, { path: '/en', viewport: 'mobile', mismatchBefore: 22, mismatchAfter: 8, fixed: true });

    // Re-evaluated metrics are folded back into the visual checks.
    const repairedDesktop = repaired.find(
      (check) => check.path === '/en' && check.viewport === 'desktop',
    );
    assert.equal(repairedDesktop?.mismatchPercent, 5);
    assert.equal(repairedDesktop?.passed, true);
    // The passing route is untouched.
    const untouched = repaired.find(
      (check) => check.path === '/en/about' && check.viewport === 'desktop',
    );
    assert.equal(untouched?.mismatchPercent, 4);
  } finally {
    await cleanup(fixtures);
  }
});

test('repair > a failed rebuild records residual outcome with null after', async () => {
  const fixtures = await makeFixtures();
  const { outputDir, reference, diff } = fixtures;
  try {
    const { repairs, visuals } = await runVisualRepairPass({
      visuals: [visualCheck('/en', 'desktop', 40, false, reference, diff)],
      componentPathsByRoute: new Map([['/en', 'src/pages/HomePage.tsx']]),
      outputDir,
      repairComponent: async () => 'export function HomePage() {\n  return <div>x</div>;\n}\n',
      rebuild: async () => false,
      reVerify: async () => [],
    });

    assert.equal(repairs.length, 1);
    assert.equal(repairs[0]?.mismatchBefore, 40);
    assert.equal(repairs[0]?.mismatchAfter, null);
    assert.equal(repairs[0]?.fixed, false);
    // Visuals keep the pre-repair verdict when re-verification never ran.
    assert.equal(visuals[0]?.mismatchPercent, 40);
  } finally {
    await cleanup(fixtures);
  }
});

test('repair > a route without a component mapping is skipped', async () => {
  const fixtures = await makeFixtures();
  const { outputDir, reference, diff } = fixtures;
  try {
    let calls = 0;
    const { repairs } = await runVisualRepairPass({
      visuals: [visualCheck('/missing', 'desktop', 60, false, reference, diff)],
      componentPathsByRoute: new Map(),
      outputDir,
      repairComponent: async () => {
        calls += 1;
        return 'x';
      },
      rebuild: async () => true,
      reVerify: async () => [],
    });
    assert.equal(calls, 0);
    assert.equal(repairs.length, 0);
  } finally {
    await cleanup(fixtures);
  }
});

// ---------------------------------------------------------------------------
// Repair prompt construction (spec s7)
// ---------------------------------------------------------------------------

test('repair > prompt names the component and stays localized', () => {
  const { text, systemPrompt } = buildVisualRepairPrompt('src/pages/HomePage.tsx', 30.5);

  // The failing component is named in the prompt.
  assert.ok(text.includes('src/pages/HomePage.tsx'));
  // The mismatch metric is surfaced.
  assert.ok(text.includes('30.50%'));
  // Both images are described: reference first, diff overlay second.
  assert.ok(text.includes('reference screenshot'));
  assert.ok(text.includes('pixelmatch diff overlay'));
  // Localized corrections only: no rewrite, no truncation.
  assert.ok(text.includes('Do NOT rewrite unrelated'));
  assert.ok(text.includes('do NOT truncate the file'));
  assert.ok(systemPrompt.includes('minimum targeted styling corrections'));
});
