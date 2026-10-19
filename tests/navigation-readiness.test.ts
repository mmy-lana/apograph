/**
 * Regression tests for resilient navigation readiness (remediation record
 * #16): `networkidle` is the preferred settle state, but a timeout on a
 * committed navigation degrades to an explicit `settled: false` outcome
 * instead of failing the route; genuine navigation failures still throw.
 *
 * Stubbed page objects with generic URLs (example.com) — no browser needed.
 *
 * spec: automate-testing-self-fixing.md remediation record #16 (Experiment 6).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { gotoWithReadiness, reloadWithReadiness } from '../dist/crawler/navigation.js';
import type { Page } from 'playwright';

function timeoutError(): Error {
  const error = new Error('Timeout 30000ms exceeded.');
  error.name = 'TimeoutError';
  return error;
}

function stubPage(behavior: {
  goto?: () => Promise<void>;
  reload?: () => Promise<void>;
  url?: string;
  waits?: number[];
}): { page: Page; waits: number[] } {
  const waits = behavior.waits ?? [];
  const page = {
    goto: behavior.goto ?? (async () => undefined),
    reload: behavior.reload ?? (async () => undefined),
    url: () => behavior.url ?? 'https://www.example.com/',
    waitForTimeout: async (ms: number) => {
      waits.push(ms);
    },
  } as unknown as Page;
  return { page, waits };
}

test('navigation-readiness > clean networkidle settle reports settled', async () => {
  const { page } = stubPage({});
  const outcome = await gotoWithReadiness(page, 'https://www.example.com/');
  assert.deepEqual(outcome, { navigated: true, settled: true });
});

test('navigation-readiness > idle timeout on a committed navigation degrades gracefully', async () => {
  let calls = 0;
  const { page, waits } = stubPage({
    goto: async () => {
      calls += 1;
      throw timeoutError();
    },
    url: 'https://www.example.com/page',
  });
  const outcome = await gotoWithReadiness(page, 'https://www.example.com/page', {
    timeoutMs: 30_000,
    settleMs: 2_000,
  });
  assert.equal(calls, 1);
  assert.equal(outcome.navigated, true);
  assert.equal(outcome.settled, false);
  assert.ok(outcome.note?.includes('network idle did not settle'));
  assert.deepEqual(waits, [2_000]);
});

test('navigation-readiness > timeout without a committed navigation still throws', async () => {
  const { page } = stubPage({
    goto: async () => {
      throw timeoutError();
    },
    url: 'about:blank',
  });
  await assert.rejects(() => gotoWithReadiness(page, 'https://www.example.com/'));
});

test('navigation-readiness > real navigation failures still throw', async () => {
  const { page } = stubPage({
    goto: async () => {
      throw new Error('net::ERR_CONNECTION_REFUSED');
    },
    url: 'about:blank',
  });
  await assert.rejects(() => gotoWithReadiness(page, 'https://www.example.com/'));
});

test('navigation-readiness > reload follows the same settle semantics', async () => {
  const { page: cleanPage } = stubPage({});
  assert.deepEqual(await reloadWithReadiness(cleanPage), { navigated: true, settled: true });

  const { page: stuckPage } = stubPage({
    reload: async () => {
      throw timeoutError();
    },
    url: 'https://www.example.com/',
  });
  const outcome = await reloadWithReadiness(stuckPage);
  assert.equal(outcome.navigated, true);
  assert.equal(outcome.settled, false);
  assert.ok(outcome.note?.includes('reload committed'));
});
