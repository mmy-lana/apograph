/**
 * Unit tests for the bounded transient retry policy (llm.ts).
 *
 * Runs on native node:test. No network access and no real endpoints: model
 * calls use deterministic LanguageModelV1 stubs and the retry loop gets
 * injected fake sleep/random collaborators.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateStructuredFilesFromParts,
  repairCodeFile,
  classifyProviderError,
  isNetworkResetError,
  computeBackoffMs,
  withTransientRetry,
  ProviderAuthError,
  MAX_ATTEMPTS,
  BACKOFF_BUDGET_MS,
  BACKOFF_SCHEDULE,
} from '../dist/synthesizer/llm.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds an APICallError-shaped provider error with an HTTP status. */
function apiError(
  statusCode: number,
  message = 'gateway failure',
  responseHeaders?: Record<string, string>,
): Error {
  return Object.assign(new Error(message), {
    statusCode,
    ...(responseHeaders !== undefined ? { responseHeaders } : {}),
  });
}

/** Minimal deterministic LanguageModelV1 stub (mirrors config.test.ts). */
function mockModel(impl: () => Promise<unknown>): never {
  const stub = {
    specificationVersion: 'v1',
    provider: 'mock',
    modelId: 'mock-model',
    defaultObjectGenerationMode: 'json',
    doGenerate: impl,
  };
  return stub as never;
}

/** Successful generateObject payload for GeneratedProjectSchema. */
const okGenerate = async () => ({
  finishReason: 'stop',
  usage: { promptTokens: 1, completionTokens: 1 },
  text: '{"files":[{"path":"src/a.ts","content":"x"}]}',
  rawCall: { rawPrompt: null, rawSettings: {} },
});

/** Recording fake sleep plus fixed jitter RNG for deterministic backoff. */
function fakeClock(): { sleeps: number[]; sleep: (ms: number) => Promise<void>; random: () => number } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('classifyProviderError', () => {
  test('429/502/503/408 are retryable', () => {
    for (const status of [429, 502, 503, 408]) {
      assert.equal(classifyProviderError(apiError(status)), 'retry', `status ${status}`);
    }
  });

  test('401/403 abort with auth error (no retry)', () => {
    assert.equal(classifyProviderError(apiError(401)), 'auth-abort');
    assert.equal(classifyProviderError(apiError(403)), 'auth-abort');
  });

  test('400/404/500/unknown raise immediately (no retry)', () => {
    for (const status of [400, 404, 500]) {
      assert.equal(classifyProviderError(apiError(status)), 'raise', `status ${status}`);
    }
    assert.equal(classifyProviderError(new Error('boom')), 'raise');
    assert.equal(classifyProviderError(undefined), 'raise');
  });

  test('abort/timeout expiry is terminal even with retryable status', () => {
    const timeout = Object.assign(new Error('aborted due to timeout'), { name: 'TimeoutError' });
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    assert.equal(classifyProviderError(timeout), 'raise');
    assert.equal(classifyProviderError(abort), 'raise');
  });

  test('RetryError-style wrappers are unwrapped before classification', () => {
    const wrapped = Object.assign(new Error('Failed after 1 attempts'), {
      lastError: apiError(503),
    });
    assert.equal(classifyProviderError(wrapped), 'retry');
  });
});

// ---------------------------------------------------------------------------
// Backoff policy
// ---------------------------------------------------------------------------

describe('computeBackoffMs (schedule and jitter)', () => {
  test('matches the specified schedule bounds for every slot', () => {
    for (let attempt = 1; attempt <= BACKOFF_SCHEDULE.length; attempt += 1) {
      const slot = BACKOFF_SCHEDULE[attempt - 1] as { baseMs: number; jitterMs: number };
      assert.equal(computeBackoffMs(attempt, () => 0), slot.baseMs - slot.jitterMs);
      assert.equal(computeBackoffMs(attempt, () => 1), slot.baseMs + slot.jitterMs);
      assert.equal(computeBackoffMs(attempt, () => 0.5), slot.baseMs);
    }
  });

  test('schedule is exactly 3s±500ms, 7s±1000ms, 15s±1500ms', () => {
    assert.deepEqual(
      BACKOFF_SCHEDULE.map((slot) => [slot.baseMs, slot.jitterMs]),
      [[3000, 500], [7000, 1000], [15000, 1500]],
    );
  });
});

// ---------------------------------------------------------------------------
// withTransientRetry
// ---------------------------------------------------------------------------

describe('withTransientRetry (bounded transient retry loop)', () => {
  test('503 twice then success: 3 attempts, waits 3s then 7s', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await withTransientRetry(
      async () => {
        calls += 1;
        if (calls <= 2) throw apiError(503);
        return 'ok';
      },
      clock,
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
    assert.deepEqual(clock.sleeps, [3000, 7000]);
  });

  test('persistent 503: gives up after MAX_ATTEMPTS with the original error', async () => {
    const clock = fakeClock();
    let calls = 0;
    const failure = apiError(503);
    await assert.rejects(
      withTransientRetry(
        async () => {
          calls += 1;
          throw failure;
        },
        clock,
      ),
      (error: unknown) => error === failure,
    );
    assert.equal(calls, MAX_ATTEMPTS);
    assert.equal(clock.sleeps.length, MAX_ATTEMPTS - 1);
  });

  test('429 honors Retry-After over computed backoff and reports progress', async () => {
    const clock = fakeClock();
    const messages: string[] = [];
    let calls = 0;
    const result = await withTransientRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw apiError(429, 'rate limited', { 'retry-after': '2' });
        return 'ok';
      },
      { ...clock, onRetry: (message) => messages.push(message) },
    );
    assert.equal(result, 'ok');
    assert.deepEqual(clock.sleeps, [2000], 'Retry-After 2s must win over the 3s schedule');
    assert.deepEqual(messages, ['Gateway at capacity — retrying in 2s (attempt 2/3)']);
  });

  test('Retry-After is bounded by the remaining backoff budget', async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      withTransientRetry(
        async () => {
          calls += 1;
          throw apiError(429, 'rate limited', { 'retry-after': '600' });
        },
        clock,
      ),
      /rate limited/,
    );
    // 600s is clamped to the 90s budget; the budget is then exhausted, so
    // the second failure ends the loop (2 calls total).
    assert.deepEqual(clock.sleeps, [BACKOFF_BUDGET_MS]);
    assert.equal(calls, 2);
  });

  test('401 aborts immediately with an actionable ProviderAuthError', async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      withTransientRetry(
        async () => {
          calls += 1;
          throw apiError(401, 'invalid api key sk-secret-123456');
        },
        clock,
      ),
      (error: unknown) => {
        assert.ok(error instanceof ProviderAuthError);
        assert.equal(error.statusCode, 401);
        assert.match(error.message, /API key/);
        assert.match(error.message, /apograph config/);
        assert.ok(!error.message.includes('sk-secret-123456'), 'secret must be redacted');
        return true;
      },
    );
    assert.equal(calls, 1, 'auth failures must not be retried');
    assert.deepEqual(clock.sleeps, []);
  });

  test('403 aborts immediately as well', async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      withTransientRetry(
        async () => {
          calls += 1;
          throw apiError(403, 'forbidden');
        },
        clock,
      ),
      (error: unknown) => error instanceof ProviderAuthError,
    );
    assert.equal(calls, 1);
    assert.deepEqual(clock.sleeps, []);
  });

  test('400 rejection raises immediately without retry', async () => {
    const clock = fakeClock();
    let calls = 0;
    const failure = apiError(400, 'invalid_request_error: prompt exceeds limit');
    await assert.rejects(
      withTransientRetry(
        async () => {
          calls += 1;
          throw failure;
        },
        clock,
      ),
      (error: unknown) => error === failure,
    );
    assert.equal(calls, 1);
    assert.deepEqual(clock.sleeps, []);
  });

  test('timeout/abort errors are terminal', async () => {
    const clock = fakeClock();
    let calls = 0;
    const timeout = Object.assign(new Error('aborted due to timeout'), { name: 'TimeoutError' });
    await assert.rejects(
      withTransientRetry(
        async () => {
          calls += 1;
          throw timeout;
        },
        clock,
      ),
      (error: unknown) => error === timeout,
    );
    assert.equal(calls, 1);
    assert.deepEqual(clock.sleeps, []);
  });
});

// ---------------------------------------------------------------------------
// generateStructuredFilesFromParts integration (injected mock model)
// ---------------------------------------------------------------------------

describe('generateStructuredFilesFromParts (retry integration)', () => {
  test('503 then success: files are returned after one bounded retry', async () => {
    const clock = fakeClock();
    let calls = 0;
    const files = await generateStructuredFilesFromParts(
      [{ type: 'text', text: 'build the page' }],
      undefined,
      {
        ...clock,
        model: mockModel(async () => {
          calls += 1;
          if (calls === 1) throw apiError(503);
          return okGenerate();
        }) as never,
      },
    );
    assert.equal(files.length, 1);
    assert.equal(files[0]?.path, 'src/a.ts');
    assert.equal(calls, 2);
    assert.deepEqual(clock.sleeps, [3000]);
  });

  test('HTTP 401 raises ProviderAuthError and never retries', async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      generateStructuredFilesFromParts([{ type: 'text', text: 'x' }], undefined, {
        ...clock,
        model: mockModel(async () => {
          calls += 1;
          throw apiError(401, 'bad key');
        }) as never,
      }),
      (error: unknown) => error instanceof ProviderAuthError,
    );
    assert.equal(calls, 1);
  });

  test('HTTP 400 non-structured rejection raises immediately', async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      generateStructuredFilesFromParts([{ type: 'text', text: 'x' }], undefined, {
        ...clock,
        model: mockModel(async () => {
          calls += 1;
          throw apiError(400, 'invalid_request_error: prompt exceeds limit');
        }) as never,
      }),
      /prompt exceeds limit/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(clock.sleeps, []);
  });

  test('unsupported structured output falls back to generateText JSON extraction', async () => {
    const clock = fakeClock();
    let calls = 0;
    const files = await generateStructuredFilesFromParts(
      [{ type: 'text', text: 'x' }],
      undefined,
      {
        ...clock,
        model: mockModel(async () => {
          calls += 1;
          if (calls === 1) throw new Error('response_format is not supported');
          return {
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1 },
            text: '{"files":[{"path":"src/b.ts","content":"y"}]}',
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        }) as never,
      },
    );
    assert.equal(files[0]?.path, 'src/b.ts');
    assert.equal(calls, 2, 'one generateObject probe + one generateText fallback');
    assert.deepEqual(clock.sleeps, [], 'protocol fallback is not a transient retry');
  });

  test('repairCodeFile shares the retry policy', async () => {
    const clock = fakeClock();
    let calls = 0;
    const repaired = await repairCodeFile('src/a.ts', 'bad code', ['TS1005'], {
      ...clock,
      model: mockModel(async () => {
        calls += 1;
        if (calls === 1) throw apiError(503);
        return {
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1 },
          text: 'fixed code',
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      }) as never,
    });
    assert.equal(repaired, 'fixed code');
    assert.equal(calls, 2);
    assert.deepEqual(clock.sleeps, [3000]);
  });
});

// ---------------------------------------------------------------------------
// Network/socket dropouts
// ---------------------------------------------------------------------------

describe('network/socket dropouts (transient reconnects)', () => {
  test('an error with code ECONNRESET is classified as retryable', () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    assert.equal(isNetworkResetError(reset), true);
    assert.equal(classifyProviderError(reset), 'retry');
  });

  test('cause codes, undici codes, and messages all mark transient dropouts', () => {
    // Node fetch failures: message 'fetch failed', code on error.cause.
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
        code: 'ECONNREFUSED',
      }),
    });
    assert.equal(classifyProviderError(refused), 'retry');

    const timedOut = Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' });
    assert.equal(classifyProviderError(timedOut), 'retry');

    const undici = Object.assign(new Error('connect timeout'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });
    assert.equal(classifyProviderError(undici), 'retry');

    assert.equal(classifyProviderError(new Error('fetch failed')), 'retry');
    assert.equal(classifyProviderError(new Error('read ECONNRESET')), 'retry');

    // RetryError-style wrappers around a dropout stay retryable.
    const wrapped = Object.assign(new Error('Failed after 1 attempts'), {
      lastError: Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }),
    });
    assert.equal(classifyProviderError(wrapped), 'retry');

    // Unrelated errors keep raising immediately.
    assert.equal(classifyProviderError(new Error('boom')), 'raise');
    assert.equal(isNetworkResetError(new Error('boom')), false);
  });

  test('network dropouts trigger the bounded backoff loop', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await withTransientRetry(
      async () => {
        calls += 1;
        if (calls <= 2) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        return 'ok';
      },
      clock,
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
    assert.deepEqual(clock.sleeps, [3000, 7000]);
  });
});

// ---------------------------------------------------------------------------
// No-object-generated protocol fallback (remediation record: tool not called)
// ---------------------------------------------------------------------------

/**
 * Builds an AI SDK `NoObjectGeneratedError`-shaped failure: the model
 * answered but never invoked the structured-output tool. Optionally carries
 * the raw response text the SDK attaches for salvage.
 */
function noObjectGenerated(text?: string, message = 'No object generated: the tool was not called.'): Error {
  return Object.assign(new Error(message), {
    name: 'AI_NoObjectGeneratedError',
    ...(text !== undefined ? { text } : {}),
  });
}

describe('generateStructuredFilesFromParts (no-object-generated fallback)', () => {
  test('salvages project JSON from the failed structured call without a second LLM round-trip', async () => {
    const clock = fakeClock();
    let calls = 0;
    const files = await generateStructuredFilesFromParts(
      [{ type: 'text', text: 'build the page' }],
      undefined,
      {
        ...clock,
        model: mockModel(async () => {
          calls += 1;
          throw noObjectGenerated('{"files":[{"path":"src/salvaged.ts","content":"s"}]}');
        }) as never,
      },
    );
    assert.equal(files[0]?.path, 'src/salvaged.ts');
    assert.equal(calls, 1, 'salvage must avoid a second generation call');
    assert.deepEqual(clock.sleeps, []);
  });

  test('falls back to generateText JSON extraction when the response text is not salvageable', async () => {
    const clock = fakeClock();
    let calls = 0;
    const files = await generateStructuredFilesFromParts(
      [{ type: 'text', text: 'x' }],
      undefined,
      {
        ...clock,
        model: mockModel(async () => {
          calls += 1;
          if (calls === 1) throw noObjectGenerated('I would rather describe it in prose.');
          return {
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1 },
            text: '{"files":[{"path":"src/fallback.ts","content":"y"}]}',
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        }) as never,
      },
    );
    assert.equal(files[0]?.path, 'src/fallback.ts');
    assert.equal(calls, 2, 'one failed structured call + one generateText fallback');
    assert.deepEqual(clock.sleeps, [], 'protocol fallback is not a transient retry');
  });

  test('detects the failure by error name even with an unrelated message', async () => {
    const clock = fakeClock();
    let calls = 0;
    const files = await generateStructuredFilesFromParts(
      [{ type: 'text', text: 'x' }],
      undefined,
      {
        ...clock,
        model: mockModel(async () => {
          calls += 1;
          if (calls === 1) {
            throw Object.assign(new Error('tool invocation missing from response'), {
              name: 'AI_NoObjectGeneratedError',
            });
          }
          return {
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1 },
            text: '{"files":[{"path":"src/named.ts","content":"n"}]}',
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        }) as never,
      },
    );
    assert.equal(files[0]?.path, 'src/named.ts');
    assert.equal(calls, 2);
    assert.deepEqual(clock.sleeps, []);
  });
});
