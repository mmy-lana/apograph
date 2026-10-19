/**
 * Rule C enforcement regression tests (emit hygiene):
 *
 * Emitted projects must never contain runtime layout-forcing helpers —
 * no MutationObservers, no window event listeners, no timer/animation loops,
 * no geometry/coordinate replay modules, and no client-side DOM rewriting.
 * Visual fidelity is produced at build time through semantic JSX and standard
 * Tailwind utilities, so these tests pin the deterministic generator surface
 * and the synthesizer source to that contract with generic fixtures.
 *
 * spec: automate-testing-self-fixing.md remediation record #14 (Experiment 6).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateIndexCss, generateMainTsx } from '../dist/synthesizer/modular.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Runtime layout-forcing signatures that must never be emitted. */
const BANNED_RUNTIME_TOKENS = [
  'MutationObserver',
  'addEventListener',
  'setInterval',
  'requestAnimationFrame',
  'geometry-replay',
  'installGeometryReplay',
];

function assertNoRuntimeHelpers(source: string, label: string): void {
  for (const token of BANNED_RUNTIME_TOKENS) {
    assert.equal(
      source.includes(token),
      false,
      `${label} must not contain runtime helper "${token}" (Rule C)`,
    );
  }
}

test('emit-hygiene > generated entrypoint is plain React bootstrap only', () => {
  const mainTsx = generateMainTsx();
  assertNoRuntimeHelpers(mainTsx, 'main.tsx');
  assert.ok(mainTsx.includes('createRoot'));
  assert.ok(mainTsx.includes('App'));
});

test('emit-hygiene > generated stylesheet is build-time CSS only', () => {
  const indexCss = generateIndexCss(
    { colors: {}, fonts: [], spacing: [], radii: [] },
    '#ffffff',
  );
  assertNoRuntimeHelpers(indexCss, 'index.css');
  assert.ok(indexCss.includes('@theme'));
});

test('emit-hygiene > synthesizer source emits no runtime replay machinery', async () => {
  const dir = join(SRC_ROOT, 'src', 'synthesizer');
  const files = (await readdir(dir)).filter((name) => name.endsWith('.ts'));
  assert.ok(files.length > 0);
  for (const name of files) {
    // llm.ts may use engine-side timers for retry backoff; nothing else may,
    // and no synthesizer file may reference replay machinery at all.
    const source = await readFile(join(dir, name), 'utf8');
    assert.equal(
      source.includes('geometry-replay') || source.includes('geometryReplay'),
      false,
      `${name} must not reference the removed runtime replay module`,
    );
    assert.equal(source.includes('MutationObserver'), false, `${name} must not use MutationObserver`);
    if (name !== 'llm.ts') {
      assert.equal(source.includes('setInterval'), false, `${name} must not use setInterval`);
    }
  }
});
