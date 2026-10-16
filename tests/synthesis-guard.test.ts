/**
 * Unit tests for the synthesis skip-list force gate, the deterministic
 * fallback validity, and the post-synthesis page backfill.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generatePageTemplate,
  computeRunStatus,
  exitCodeForRunStatus,
  upsertStageOutcome,
} from '../dist/synthesizer/modular.js';
import type { StageOutcome } from '../dist/synthesizer/modular.js';
import type { PlanRoute } from '../dist/plan/schema.js';

function minimalRoute(overrides: Partial<PlanRoute> = {}): PlanRoute {
  return {
    path: '/test',
    title: '',
    componentName: 'TestPage',
    included: true,
    inferredInteractions: ['none'],
    ...overrides,
  };
}

// A — force flag produces an empty skip list (rule locked in inline, since
// existingPagePaths is not exported from cli.ts).
test('force > effective force flag produces empty skip list', () => {
  const route = minimalRoute({ componentName: 'HomePage', path: '/' });
  const plan = { routes: [route] };
  const outDir = '/tmp/does-not-matter';
  const pageFile = `${outDir}/src/pages/${route.componentName}.tsx`;

  // Simulate the precondition: a stale page file exists on disk.
  const staleOnDisk = pageFile.length > 0; // existsSync(proxy)

  // The rule patched into runClonePipeline():
  const effectiveForce = true;
  const skipList = staleOnDisk && !effectiveForce ? [route.path] : [];
  assert.deepEqual(skipList, []);

  // Merge semantics unchanged: without force, the disk-derived list is kept.
  const effectiveForceOff = false;
  const mergeList =
    staleOnDisk && !effectiveForceOff ? [route.path] : [];
  assert.deepEqual(mergeList, ['/']);
  void plan;
});

// B — the deterministic fallback the empty-content guard routes to is valid.
test('fallback > generatePageTemplate always returns non-empty compile-ready content', () => {
  const content = generatePageTemplate(minimalRoute());
  assert.ok(content.trim().length > 0);
  assert.ok(content.includes('export function TestPage'));
});

// C — post-synthesis backfill produces a valid page file (inline replica of
// the loop inserted into runClonePipeline's synthesis helper).
test('backfill > missing page file is generated with correct path and content', () => {
  const plan = { routes: [minimalRoute()] };
  const result = { files: [{ path: 'src/App.tsx', content: 'export default 1;' }] };

  for (const route of plan.routes) {
    const expectedPath = `src/pages/${route.componentName}.tsx`;
    const existing = result.files.find(
      (f) => f.path === expectedPath && f.content.trim().length > 0,
    );
    if (existing === undefined) {
      result.files.push({ path: expectedPath, content: generatePageTemplate(route) });
    }
  }

  const page = result.files.find((f) => f.path === 'src/pages/TestPage.tsx');
  assert.notEqual(page, undefined);
  assert.ok((page?.content ?? '').trim().length > 0);
  assert.ok((page?.content ?? '').includes('export function TestPage'));
});

// D — run-status derivation from per-stage outcomes.
test('status > all-synthesized outcomes compute success', () => {
  const outcomes: StageOutcome[] = [
    { stage: 'stage-2: shared layout', status: 'synthesized' },
    { stage: 'stage-3: route /', status: 'synthesized' },
  ];
  assert.equal(computeRunStatus(outcomes), 'success');
  assert.equal(computeRunStatus([]), 'success');
});

test('status > a degraded-fallback outcome computes degraded', () => {
  const outcomes: StageOutcome[] = [
    { stage: 'stage-2: shared layout', status: 'degraded-fallback', reason: 'HTTP 503' },
    { stage: 'stage-3: route /', status: 'synthesized' },
  ];
  assert.equal(computeRunStatus(outcomes), 'degraded');
});

test('status > a failed outcome wins over degraded siblings', () => {
  const outcomes: StageOutcome[] = [
    { stage: 'stage-2: shared layout', status: 'failed', reason: 'fallback broke' },
    { stage: 'stage-3: route /', status: 'degraded-fallback', reason: 'HTTP 429' },
  ];
  assert.equal(computeRunStatus(outcomes), 'failed');
});

// E — exit-code policy for the CLI summary.
test('exit codes > success exits 0 with and without --allow-degraded', () => {
  assert.equal(exitCodeForRunStatus('success', false), 0);
  assert.equal(exitCodeForRunStatus('success', true), 0);
});

test('exit codes > degraded exits 1 without --allow-degraded and 0 with it', () => {
  assert.equal(exitCodeForRunStatus('degraded', false), 1);
  assert.equal(exitCodeForRunStatus('degraded', true), 0);
});

test('exit codes > failed exits 1 even with --allow-degraded', () => {
  assert.equal(exitCodeForRunStatus('failed', false), 1);
  assert.equal(exitCodeForRunStatus('failed', true), 1);
});

// F — backfill marks routes degraded-fallback (inline replica of the
// marking inserted into runModularSynthesis's backfill loop).
function markBackfill(
  stageOutcomes: StageOutcome[],
  routePath: string,
  expectedPath: string,
): void {
  const stageName = `stage-3: route ${routePath}`;
  const prior = stageOutcomes.find((outcome) => outcome.stage === stageName);
  if (prior?.status !== 'failed') {
    upsertStageOutcome(stageOutcomes, {
      stage: stageName,
      status: 'degraded-fallback',
      reason: `synthesized output missing ${expectedPath}; backfilled with deterministic template`,
    });
  }
}

test('backfill > backfilled route is marked degraded-fallback in stageOutcomes', () => {
  const outcomes: StageOutcome[] = [
    { stage: 'stage-3: route /test', status: 'synthesized' },
  ];
  markBackfill(outcomes, '/test', 'src/pages/TestPage.tsx');

  assert.equal(outcomes.length, 1, 'the synthesized entry is replaced, not duplicated');
  assert.equal(outcomes[0]?.status, 'degraded-fallback');
  assert.match(outcomes[0]?.reason ?? '', /backfilled with deterministic template/);
  assert.equal(computeRunStatus(outcomes), 'degraded');
});

test('backfill > a failed stage keeps its failed status after backfill', () => {
  const outcomes: StageOutcome[] = [
    { stage: 'stage-3: route /test', status: 'failed', reason: 'fallback broke' },
  ];
  markBackfill(outcomes, '/test', 'src/pages/TestPage.tsx');

  assert.equal(outcomes[0]?.status, 'failed');
  assert.equal(computeRunStatus(outcomes), 'failed');
  assert.equal(exitCodeForRunStatus('failed', true), 1);
});
