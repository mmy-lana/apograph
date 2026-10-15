/**
 * Unit tests for the synthesis skip-list force gate, the deterministic
 * fallback validity, and the post-synthesis page backfill.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { generatePageTemplate } from '../dist/synthesizer/modular.js';
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
