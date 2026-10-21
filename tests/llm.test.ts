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
  parseGeneratedFiles,
  parseFileSections,
  resolveLlmTimeoutMs,
  FILE_EMISSION_CONTRACT,
  ProviderAuthError,
  MAX_ATTEMPTS,
  MAX_STAGE_TIMEOUT_MS,
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

  test('unsupported structured output falls back to a text extraction turn', async () => {
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
    assert.equal(calls, 2, 'one failed call + one bounded extraction turn');
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
 * Builds an AI SDK `NoObjectGeneratedError`-shaped protocol failure (the
 * model answered but no usable payload came back). Optionally carries the
 * raw response text the SDK attaches for salvage.
 */
function noObjectGenerated(text?: string, message = 'No object generated: the tool was not called.'): Error {
  return Object.assign(new Error(message), {
    name: 'AI_NoObjectGeneratedError',
    ...(text !== undefined ? { text } : {}),
  });
}

describe('generateStructuredFilesFromParts (protocol-failure salvage)', () => {
  test('salvages project files from the failed call text without a second LLM round-trip', async () => {
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

  test('spends one bounded extraction turn when the response text is not salvageable', async () => {
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
    assert.equal(calls, 2, 'one failed call + one bounded extraction turn');
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

// ---------------------------------------------------------------------------
// Provider body-parse failures ("Invalid JSON response")
// ---------------------------------------------------------------------------

/** APICallError-shaped provider body-parse failure (provider-utils style). */
function invalidJsonResponse(extra: { statusCode?: number; responseBody?: string } = {}): Error {
  return Object.assign(new Error('Invalid JSON response'), {
    statusCode: extra.statusCode ?? 200,
    ...(extra.responseBody !== undefined ? { responseBody: extra.responseBody } : {}),
  });
}

describe('classifyProviderError (provider body-parse failures)', () => {
  test('2xx Invalid JSON response is a bounded transient provider fault', () => {
    assert.equal(classifyProviderError(invalidJsonResponse({ statusCode: 200 })), 'retry');
    assert.equal(classifyProviderError(invalidJsonResponse({})), 'retry', 'absent status counts as provider fault');
    assert.equal(classifyProviderError(invalidJsonResponse({ statusCode: 503 })), 'retry');
  });

  test('4xx Invalid JSON response still raises immediately (no retry)', () => {
    assert.equal(classifyProviderError(invalidJsonResponse({ statusCode: 400 })), 'raise');
    assert.equal(classifyProviderError(invalidJsonResponse({ statusCode: 404 })), 'raise');
  });
});

describe('generateStructuredFilesFromParts (invalid-JSON-response fallback)', () => {
  test('salvages project files from the raw responseBody without a second call', async () => {
    const clock = fakeClock();
    let calls = 0;
    const files = await generateStructuredFilesFromParts(
      [{ type: 'text', text: 'build the page' }],
      undefined,
      {
        ...clock,
        model: mockModel(async () => {
          calls += 1;
          throw invalidJsonResponse({
            responseBody: '{"note":"gateway wrapper","files":[{"path":"src/body.ts","content":"b"}]}',
          });
        }) as never,
      },
    );
    assert.equal(files[0]?.path, 'src/body.ts');
    assert.equal(calls, 1, 'salvage must avoid a second generation call');
    assert.deepEqual(clock.sleeps, []);
  });

  test('un-salvageable invalid-JSON falls back to a text extraction turn', async () => {
    const clock = fakeClock();
    let calls = 0;
    const files = await generateStructuredFilesFromParts(
      [{ type: 'text', text: 'x' }],
      undefined,
      {
        ...clock,
        model: mockModel(async () => {
          calls += 1;
          if (calls === 1) throw invalidJsonResponse({ responseBody: '{"error":"upstream unavailable"}' });
          return {
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1 },
            text: '{"files":[{"path":"src/recovered.ts","content":"r"}]}',
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        }) as never,
      },
    );
    assert.equal(files[0]?.path, 'src/recovered.ts');
    assert.equal(calls, 2, 'one failed call + one bounded extraction turn');
    assert.deepEqual(clock.sleeps, [], 'protocol fallback itself is not a retry');
  });

  test('model-output JSON parse failures also salvage and fall back', async () => {
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
            return {
              finishReason: 'stop',
              usage: { promptTokens: 1, completionTokens: 1 },
              text: 'not json but {"files":[{"path":"src/mid.ts","content":"m"}]} trailing',
              rawCall: { rawPrompt: null, rawSettings: {} },
            };
          }
          return {
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1 },
            text: '{"files":[{"path":"src/second.ts","content":"s"}]}',
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        }) as never,
      },
    );
    // The first reply is un-parseable as file sections; the lenient legacy
    // extractor recovers the embedded project files without a second call.
    assert.equal(files[0]?.path, 'src/mid.ts');
    assert.equal(calls, 1);
    assert.deepEqual(clock.sleeps, []);
  });

  test('persistent body corruption retries boundedly then raises', async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      generateStructuredFilesFromParts([{ type: 'text', text: 'x' }], undefined, {
        ...clock,
        model: mockModel(async () => {
          calls += 1;
          throw invalidJsonResponse({ responseBody: '{"error":"corrupt"}' });
        }) as never,
      }),
      /Invalid JSON response/,
    );
    assert.equal(calls, 4, 'call + extraction turn on attempt 1, then single calls on attempts 2-3');
    assert.deepEqual(clock.sleeps, [3000, 7000], 'bounded transient backoff between attempts');
  });
});

// ---------------------------------------------------------------------------
// Markdown file-section extraction (regression: JSON-in-JSON parse crashes)
// ---------------------------------------------------------------------------

describe('parseFileSections / parseGeneratedFiles (robust file extraction)', () => {
  test('extracts multi-file responses from ### File: sections with fenced bodies', () => {
    const text = [
      'Here are the synthesized files.',
      '',
      '### File: src/components/Navbar.tsx',
      '```tsx',
      'export function Navbar() { return <nav />; }',
      '```',
      '',
      '### File: src/pages/HomePage.tsx',
      '```tsx',
      'export function HomePage() {',
      '  return <main className="flex min-h-screen w-full flex-col" />;',
      '}',
      '```',
    ].join('\n');

    const files = parseGeneratedFiles(text);
    assert.equal(files.length, 2);
    assert.equal(files[0]?.path, 'src/components/Navbar.tsx');
    assert.equal(files[0]?.content, 'export function Navbar() { return <nav />; }');
    assert.equal(files[1]?.path, 'src/pages/HomePage.tsx');
    assert.ok(files[1]?.content.includes('min-h-screen'));
  });

  test('tolerates bold headers, language tags, and long closing fences', () => {
    const text = [
      '**File: src/lib/util.ts**',
      '```ts',
      'export const answer = 42;',
      '````',
    ].join('\n');
    const files = parseFileSections(text);
    assert.equal(files.length, 1);
    assert.equal(files[0]?.path, 'src/lib/util.ts');
    assert.equal(files[0]?.content, 'export const answer = 42;');
  });

  test('file content is never JSON-unescaped — backslashes survive verbatim', () => {
    const text = [
      '### File: src/lib/patterns.ts',
      '```ts',
      'export const DIGIT = /\\d+/g; // a classic bad JSON escape',
      'export const QUOTED = "she said \\"hi\\"";',
      '```',
    ].join('\n');
    const files = parseGeneratedFiles(text);
    assert.equal(files[0]?.content, [
      'export const DIGIT = /\\d+/g; // a classic bad JSON escape',
      'export const QUOTED = "she said \\"hi\\"";',
    ].join('\n'));
  });

  test('rejects unsafe paths and empty bodies instead of emitting broken files', () => {
    const text = [
      '### File: /etc/passwd',
      '```',
      'root:x:0:0',
      '```',
      '### File: src/../../escape.ts',
      '```',
      'evil',
      '```',
      '### File: src/empty.ts',
      '```',
      '```',
      '### File: src/ok.ts',
      '```',
      'export {};',
      '```',
    ].join('\n');
    const files = parseGeneratedFiles(text);
    assert.deepEqual(files.map((file) => file.path), ['src/ok.ts']);
  });

  test('legacy {"files": [...]} payloads still parse leniently', () => {
    const files = parseGeneratedFiles('{"files":[{"path":"src/a.ts","content":"x"}]}');
    assert.equal(files.length, 1);
    assert.equal(files[0]?.path, 'src/a.ts');
  });

  test('legacy JSON with invalid string escapes is repaired, never thrown', () => {
    // The exact regression: `\\d` (and friends) inside content strings used
    // to crash with "Bad escaped character in JSON at position X".
    const raw =
      '{"files":[{"path":"src/re.ts","content":"const re = /\\d+/; const win = C:\\\\tmp"}]}';
    const files = parseGeneratedFiles(raw);
    assert.equal(files.length, 1);
    assert.equal(files[0]?.content, 'const re = /\\d+/; const win = C:\\tmp');
  });

  test('defaultPath accepts a raw or single-fenced reply for repair turns', () => {
    const raw = parseGeneratedFiles('export const fixed = true;', {
      defaultPath: 'src/pages/Home.tsx',
    });
    assert.deepEqual(raw, [{ path: 'src/pages/Home.tsx', content: 'export const fixed = true;' }]);

    const fenced = parseGeneratedFiles('```\nexport const fixed = true;\n```', {
      defaultPath: 'src/pages/Home.tsx',
    });
    assert.deepEqual(fenced, [{ path: 'src/pages/Home.tsx', content: 'export const fixed = true;' }]);
  });

  test('unusable output yields an empty list instead of throwing', () => {
    assert.deepEqual(parseGeneratedFiles('I would rather describe it in prose.'), []);
    assert.deepEqual(parseGeneratedFiles(''), []);
    assert.deepEqual(parseGeneratedFiles('{"error":"upstream unavailable"}'), []);
    assert.deepEqual(parseGeneratedFiles('<html><body>challenge</body></html>'), []);
  });

  test('generation turns carry the markdown file-section contract', () => {
    assert.ok(FILE_EMISSION_CONTRACT.includes('### File: <project-relative/path>'));
    assert.ok(FILE_EMISSION_CONTRACT.includes('Do not wrap file contents in a JSON object'));
  });

  test('generateStructuredFilesFromParts extracts fenced replies end to end', async () => {
    const clock = fakeClock();
    const files = await generateStructuredFilesFromParts(
      [{ type: 'text', text: 'build the page' }],
      undefined,
      {
        ...clock,
        model: mockModel(async () => ({
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1 },
          text: '### File: src/pages/HomePage.tsx\n```tsx\nexport function HomePage() {}\n```',
          rawCall: { rawPrompt: null, rawSettings: {} },
        })) as never,
      },
    );
    assert.equal(files.length, 1);
    assert.equal(files[0]?.path, 'src/pages/HomePage.tsx');
    assert.equal(files[0]?.content, 'export function HomePage() {}');
  });
});

// ---------------------------------------------------------------------------
// Per-stage generation timeout bound
// ---------------------------------------------------------------------------

describe('resolveLlmTimeoutMs (per-stage timeout cap)', () => {
  test('defaults to 180s and clamps any override to the 180s cap', () => {
    const previous = process.env.APOGRAPH_LLM_TIMEOUT_MS;
    try {
      delete process.env.APOGRAPH_LLM_TIMEOUT_MS;
      assert.equal(resolveLlmTimeoutMs(), 180_000);
      assert.equal(MAX_STAGE_TIMEOUT_MS, 180_000);

      process.env.APOGRAPH_LLM_TIMEOUT_MS = '900000';
      assert.equal(resolveLlmTimeoutMs(), 180_000, 'a 15-minute override is clamped to 180s');

      process.env.APOGRAPH_LLM_TIMEOUT_MS = '30000';
      assert.equal(resolveLlmTimeoutMs(), 30_000, 'smaller overrides are honored');

      process.env.APOGRAPH_LLM_TIMEOUT_MS = 'not-a-number';
      assert.equal(resolveLlmTimeoutMs(), 180_000, 'invalid overrides fall back to the default');
    } finally {
      if (previous === undefined) delete process.env.APOGRAPH_LLM_TIMEOUT_MS;
      else process.env.APOGRAPH_LLM_TIMEOUT_MS = previous;
    }
  });
});
