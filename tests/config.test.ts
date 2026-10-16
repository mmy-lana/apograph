/**
 * Unit tests for provider validation (MODEL-01/02) and secret redaction.
 *
 * Runs on native node:test (D5). No network access and no real credentials:
 * env/config/fetch are injected per test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateProviderConfig,
  maskSecret,
  redactSecrets,
  resolveActiveProvider,
  probeModelCapabilities,
} from '../dist/config/validate.js';
import { resolveProvider, resolveModelId } from '../dist/config/models.js';
import { setConfigModel, runConfigSetCommand } from '../dist/commands/config.js';

const GATEWAY_ENV = {
  APOGRAPH_BASE_URL: 'https://gw.example.com/v1',
  APOGRAPH_API_KEY: 'sk-gw-abcdef1234567890',
};

describe('provider precedence (MODEL-01, env > config > defaults)', () => {
  test('env gateway beats a persisted config provider', () => {
    const resolved = resolveActiveProvider(GATEWAY_ENV, {
      provider: 'anthropic',
      apiKey: 'sk-ant-config-key',
    });
    assert.equal(resolved.provider, 'gateway');
    assert.equal(resolved.modelId, 'gpt-4o');
    assert.equal(resolved.apiKey, 'sk-gw-abcdef1234567890');
    assert.equal(resolved.baseUrl, 'https://gw.example.com/v1');
  });

  test('env anthropic beats persisted openai config', () => {
    const resolved = resolveActiveProvider(
      { ANTHROPIC_API_KEY: 'sk-ant-env-key' },
      { provider: 'openai', apiKey: 'sk-openai-config' },
    );
    assert.equal(resolved.provider, 'anthropic');
    assert.equal(resolved.modelId, 'claude-3-7-sonnet-latest');
  });

  test('persisted config applies when env is unset', () => {
    const resolved = resolveActiveProvider({}, { provider: 'openai', apiKey: 'sk-openai-config' });
    assert.equal(resolved.provider, 'openai');
    assert.equal(resolved.modelId, 'gpt-4o');
  });

  test('nothing set resolves to local ollama fallback', () => {
    const resolved = resolveActiveProvider({}, null);
    assert.equal(resolved.provider, 'local');
    assert.equal(resolved.modelId, 'apograph-qwen35:9b-8k');
  });

  test('resolveModelId: APOGRAPH_MODEL overrides config and defaults', () => {
    assert.equal(resolveModelId('gateway', { APOGRAPH_MODEL: 'my-model' }, null), 'my-model');
    assert.equal(resolveModelId('gateway', {}, { provider: 'gateway', model: 'cfg-model' }), 'cfg-model');
    assert.equal(resolveModelId('anthropic', {}, null), 'claude-3-7-sonnet-latest');
    assert.equal(resolveModelId('local', {}, null), 'apograph-qwen35:9b-8k');
  });

  test('resolveProvider mirrors resolveActiveProvider for all combinations', () => {
    assert.equal(resolveProvider(GATEWAY_ENV, null), 'gateway');
    assert.equal(resolveProvider({ ANTHROPIC_API_KEY: 'x' }, { provider: 'gateway' }), 'anthropic');
    assert.equal(resolveProvider({ OPENAI_API_KEY: 'x' }, { provider: 'anthropic' }), 'openai');
    assert.equal(resolveProvider({}, { provider: 'ollama' as never }), 'local');
  });
});

describe('validateProviderConfig (MODEL-02)', () => {
  test('gateway with missing credentials fails as missing-credentials', async () => {
    const report = await validateProviderConfig({
      env: {},
      config: { provider: 'gateway', baseUrl: 'https://gw.example.com/v1' },
      fetchImpl: (() => {
        throw new Error('must not be called');
      }) as typeof fetch,
    });
    assert.equal(report.provider, 'gateway');
    assert.equal(report.ok, false);
    const classes = report.checks.map((c) => c.issueClass);
    assert.ok(classes.includes('missing-credentials'));
  });

  test('gateway with missing base URL fails as missing-credentials', async () => {
    const report = await validateProviderConfig({
      env: {},
      config: { provider: 'gateway', apiKey: 'sk-gw-abcdef123456' },
      fetchImpl: (() => {
        throw new Error('must not be called');
      }) as typeof fetch,
    });
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((c) => c.issueClass === 'missing-credentials' && c.label.includes('Base URL')));
  });

  test('gateway with malformed URL fails as malformed-url without probing', async () => {
    const report = await validateProviderConfig({
      env: { ...GATEWAY_ENV, APOGRAPH_BASE_URL: 'not a url' },
      config: null,
      fetchImpl: (() => {
        throw new Error('must not be called');
      }) as typeof fetch,
    });
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((c) => c.issueClass === 'malformed-url'));
    // No credential material may appear in any detail.
    for (const check of report.checks) {
      assert.ok(!check.detail.includes('sk-gw-abcdef1234567890'));
    }
  });

  test('gateway with reachable endpoint passes', async () => {
    const report = await validateProviderConfig({
      env: GATEWAY_ENV,
      config: null,
      fetchImpl: (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch,
    });
    assert.equal(report.ok, true);
    assert.ok(report.checks.every((c) => c.status === 'pass'));
    assert.equal(report.credentialHint, maskSecret('sk-gw-abcdef1234567890'));
  });

  test('gateway auth rejection (HTTP 401) is classified as auth-rejection', async () => {
    const report = await validateProviderConfig({
      env: GATEWAY_ENV,
      config: null,
      fetchImpl: (async () => new Response('unauthorized', { status: 401 })) as typeof fetch,
    });
    assert.equal(report.ok, false);
    const check = report.checks.find((c) => c.issueClass === 'auth-rejection');
    assert.ok(check);
    assert.ok(check.detail.includes('401'));
  });

  test('gateway network failure degrades to warn (unreachable), never throws', async () => {
    const report = await validateProviderConfig({
      env: GATEWAY_ENV,
      config: null,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const check = report.checks.find((c) => c.issueClass === 'unreachable');
    assert.ok(check);
    assert.equal(check.status, 'warn');
  });

  test('anthropic with missing key fails; openai family mismatch warns only', async () => {
    const missing = await validateProviderConfig({
      env: {},
      config: { provider: 'anthropic' },
      fetchImpl: (() => {
        throw new Error('must not be called');
      }) as typeof fetch,
    });
    assert.equal(missing.provider, 'anthropic');
    assert.ok(missing.checks.some((c) => c.issueClass === 'missing-credentials'));

    const mismatch = await validateProviderConfig({
      env: { ANTHROPIC_API_KEY: 'sk-ant-abcdef123456' },
      config: { provider: 'anthropic', model: 'gpt-4o' },
      fetchImpl: (() => {
        throw new Error('must not be called');
      }) as typeof fetch,
    });
    const check = mismatch.checks.find((c) => c.issueClass === 'model-mismatch');
    assert.ok(check);
    assert.equal(check.status, 'warn');
    assert.equal(mismatch.ok, true, 'warn-only mismatch must not fail validation');
  });

  test('local provider with no credential is fine', async () => {
    const report = await validateProviderConfig({ env: {}, config: null });
    assert.equal(report.provider, 'local');
    assert.equal(report.ok, true);
    assert.equal(report.credentialHint, null);
  });
});

describe('secret redaction', () => {
  test('maskSecret keeps first 4 / last 2 and hides the middle', () => {
    const secret = 'sk-ant-api03-1234567890abcdef';
    const masked = maskSecret(secret);
    assert.equal(masked, `sk-a${'*'.repeat(secret.length - 6)}ef`);
    assert.equal(maskSecret('short'), '******');
    assert.equal(maskSecret(''), '******');
  });

  test('maskSecret output never contains the raw secret', () => {
    const secret = 'sk-ant-api03-9f8e7d6c5b4a';
    const masked = maskSecret(secret);
    assert.ok(!masked.includes(secret));
  });

  test('redactSecrets scrubs sk-shaped tokens from free text', () => {
    const message = 'request to https://gw.example.com failed with key sk-live-0123456789abcdef';
    const redacted = redactSecrets(message);
    assert.ok(!redacted.includes('sk-live-0123456789abcdef'));
    assert.ok(redacted.includes('****'));
    // Non-secret text survives.
    assert.ok(redacted.includes('https://gw.example.com failed with key'));
  });

  test('redactSecrets masks explicitly provided secrets (echoed credentials)', () => {
    const secret = 'my-custom-token-value';
    const redacted = redactSecrets(`auth failed for token my-custom-token-value`, secret);
    assert.ok(!redacted.includes(secret));
  });
});

describe('probeModelCapabilities (MODEL-03)', () => {
  /** Minimal LanguageModelV1-compatible stub (cast keeps the test light). */
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

  const okGenerate = async () => ({
    finishReason: 'stop',
    usage: { promptTokens: 1, completionTokens: 1 },
    text: '{"ok": true}',
    rawCall: { rawPrompt: null, rawSettings: {} },
  });

  test('reports both capabilities true when the model answers', async () => {
    const capabilities = await probeModelCapabilities(mockModel(async () => okGenerate()) as never);
    assert.equal(capabilities.structuredOutput, true);
    assert.equal(capabilities.vision, true);
    assert.equal(capabilities.error, undefined);
  });

  test('structured-output rejection (unsupported parameter) degrades to false', async () => {
    const capabilities = await probeModelCapabilities(
      mockModel(async () => {
        throw new Error('response_format is not supported');
      }) as never,
    );
    assert.equal(capabilities.structuredOutput, false);
    assert.equal(capabilities.vision, false, 'the same broken endpoint also fails the vision probe');
    assert.ok(capabilities.error !== undefined);
  });

  test('vision-capable model with json-only gap reports the split correctly', async () => {
    let call = 0;
    const capabilities = await probeModelCapabilities(
      mockModel(async () => {
        call += 1;
        if (call === 1) throw new Error('json_schema not supported');
        return okGenerate();
      }) as never,
    );
    assert.equal(capabilities.structuredOutput, false);
    assert.equal(capabilities.vision, true);
    assert.ok(capabilities.error !== undefined);
  });
});

// ---------------------------------------------------------------------------
// CLI model override precedence (--model / cliOverride)
// ---------------------------------------------------------------------------

describe('CLI model override precedence (resolveModelId cliOverride)', () => {
  test('cliOverride wins over APOGRAPH_MODEL env and config model', () => {
    assert.equal(
      resolveModelId(
        'gateway',
        { APOGRAPH_MODEL: 'env-model' },
        { provider: 'gateway', model: 'cfg-model' },
        'cli-model',
      ),
      'cli-model',
    );
  });

  test('cliOverride wins over every provider default', () => {
    assert.equal(resolveModelId('gateway', {}, null, 'cli-wins'), 'cli-wins');
    assert.equal(resolveModelId('anthropic', {}, null, 'cli-wins'), 'cli-wins');
    assert.equal(resolveModelId('openai', {}, null, 'cli-wins'), 'cli-wins');
    assert.equal(resolveModelId('local', {}, null, 'cli-wins'), 'cli-wins');
  });

  test('empty cliOverride is ignored (env > config > default preserved)', () => {
    assert.equal(
      resolveModelId('gateway', { APOGRAPH_MODEL: 'env-model' }, { provider: 'gateway', model: 'cfg-model' }, ''),
      'env-model',
    );
    assert.equal(
      resolveModelId('gateway', {}, { provider: 'gateway', model: 'cfg-model' }, ''),
      'cfg-model',
    );
    assert.equal(
      resolveModelId('gateway', {}, { provider: 'gateway', model: 'cfg-model' }, undefined),
      'cfg-model',
    );
    assert.equal(resolveModelId('gateway', {}, null, ''), 'gpt-4o');
    assert.equal(resolveModelId('local', {}, null, ''), 'apograph-qwen35:9b-8k');
    assert.equal(resolveModelId('anthropic', {}, null, ''), 'claude-3-7-sonnet-latest');
  });

  test('existing 3-argument calls resolve unchanged (back-compat)', () => {
    assert.equal(resolveModelId('gateway', { APOGRAPH_MODEL: 'env-model' }, null), 'env-model');
    assert.equal(resolveModelId('gateway', {}, { provider: 'gateway', model: 'cfg-model' }), 'cfg-model');
    assert.equal(resolveModelId('local', {}, null), 'apograph-qwen35:9b-8k');
  });
});

// ---------------------------------------------------------------------------
// config set --model (non-interactive model update)
// ---------------------------------------------------------------------------

describe('config set --model (non-interactive model update)', () => {
  async function writeTempConfig(raw: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'apograph-config-set-'));
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify(raw, null, 2), 'utf8');
    return path;
  }

  test('updates only the model field and preserves unknown keys', async () => {
    const path = await writeTempConfig({
      provider: 'gateway',
      model: 'old-model',
      apiKey: 'sk-test-key-1234567890',
      baseUrl: 'https://gw.example.com/v1',
      customKey: 'keep-me',
    });

    const result = await setConfigModel('new-model', path);
    assert.equal(result.model, 'new-model');
    assert.equal(result.path, path);

    const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    assert.equal(saved.model, 'new-model');
    assert.equal(saved.provider, 'gateway');
    assert.equal(saved.apiKey, 'sk-test-key-1234567890');
    assert.equal(saved.baseUrl, 'https://gw.example.com/v1');
    assert.equal(saved.customKey, 'keep-me');
  });

  test('empty model is rejected without touching the file', async () => {
    const path = await writeTempConfig({ provider: 'gateway', model: 'keep' });
    await assert.rejects(() => setConfigModel('', path), /No model specified/);
    const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    assert.equal(saved.model, 'keep');
  });

  test('missing config file fails with an actionable error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apograph-config-set-'));
    await assert.rejects(
      () => setConfigModel('x', join(dir, 'nope.json')),
      /apograph config/,
    );
  });

  test('unparseable config file is never silently rewritten', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apograph-config-set-'));
    const path = join(dir, 'config.json');
    await writeFile(path, '{ not json', 'utf8');
    await assert.rejects(() => setConfigModel('x', path), /Could not parse/);
    assert.equal(await readFile(path, 'utf8'), '{ not json');
  });

  test('runConfigSetCommand prints "Model updated to: <id>" without prompts', async () => {
    const path = await writeTempConfig({ provider: 'gateway', model: 'old', apiKey: 'sk-x' });

    const printed: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]): void => {
      printed.push(args.map(String).join(' '));
    };
    try {
      await runConfigSetCommand({ model: 'brand-new', configPath: path });
    } finally {
      console.log = originalLog;
    }

    assert.deepEqual(printed, ['Model updated to: brand-new']);
    const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    assert.equal(saved.model, 'brand-new');
  });

  test('runConfigSetCommand with empty --model rejects', async () => {
    const path = await writeTempConfig({ provider: 'gateway', model: 'keep' });
    await assert.rejects(() => runConfigSetCommand({ model: '', configPath: path }), /No model specified/);
    const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    assert.equal(saved.model, 'keep');
  });
});
