/**
 * Regression tests for pristine-DOM evidence ordering (remediation record
 * #17):
 *
 * The interactive-state probe is the crawler's one DOM-mutating pass — it
 * clicks through interactive elements (opening modals/overlays and possibly
 * triggering SPA navigations it cannot undo). All read-only evidence passes
 * (link discovery, hash sub-captures, asset discovery) must therefore run on
 * the route's pristine document BEFORE that probe; otherwise the manifest
 * samples a click-mutated DOM and silently loses content-image references
 * (observed: 51 discovered URLs before probing vs 15 after, with the page
 * navigated away from the route under capture).
 *
 * Fixtures are generic (source-order invariants only) — nothing
 * target-specific.
 *
 * spec: automate-testing-self-fixing.md remediation record #17 (Experiment 6).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function engineSource(): Promise<string> {
  return readFile(join(SRC_ROOT, 'src', 'crawler', 'engine.ts'), 'utf8');
}

function assertPrecedes(source: string, earlier: string, later: string, label: string): void {
  const earlierIndex = source.indexOf(earlier);
  const laterIndex = source.indexOf(later);
  assert.ok(earlierIndex !== -1, `${label}: expected to find ${earlier}`);
  assert.ok(laterIndex !== -1, `${label}: expected to find ${later}`);
  assert.ok(
    earlierIndex < laterIndex,
    `${label}: ${earlier} must run before the mutating interactive probe`,
  );
}

test('pristine-evidence > read-only evidence passes precede the interactive probe', async () => {
  const source = await engineSource();
  assertPrecedes(source, 'await enqueueLinks(page', 'await discoverInteractiveStates(', 'link discovery');
  assertPrecedes(source, 'await discoverHashAnchors(', 'await discoverInteractiveStates(', 'hash sub-captures');
  assertPrecedes(source, 'await discoverImageAssets(page)', 'await discoverInteractiveStates(', 'asset discovery');
});

test('pristine-evidence > the interactive probe is the documented mutating pass', async () => {
  const interactions = await readFile(
    join(SRC_ROOT, 'src', 'crawler', 'interactions.ts'),
    'utf8',
  );
  // The probe clicks real elements — that is what makes it mutating.
  assert.ok(interactions.includes('handle.click('));
  // ...and the engine comment records the ordering contract.
  const source = await engineSource();
  assert.ok(source.includes('DOM-mutating pass'));
});
