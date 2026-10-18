/**
 * Unit tests for dynamic provider progress reporting and non-destructive
 * `apograph config` behavior (GLM 5.3 Flash preset, unknown-key retention).
 *
 * spec: integration/visual-resilience s8.5
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { formatModelRouteLabel } from '../dist/synthesizer/modular.js';
import { generateFrontendScaffold } from '../dist/emitter/scaffold.js';
import {
  applyVisionPreset,
  findVisionPreset,
  mergeConfigWithUnknownKeys,
  mergePromptAnswers,
} from '../dist/commands/config.js';
import type { ApographConfig } from '../dist/commands/config.js';
import { resolveProvider, resolveModelId } from '../dist/config/models.js';

// ---------------------------------------------------------------------------
// s8.5 - progress > reports dynamic provider
// ---------------------------------------------------------------------------

test('progress > reports dynamic provider', () => {
  // Cloud gateway route (dark-canvas SPA run).
  assert.equal(
    formatModelRouteLabel('z-ai', 'glm-5.3-flash'),
    'via z-ai (glm-5.3-flash)',
  );
  // Local route.
  assert.equal(
    formatModelRouteLabel('ollama', 'apograph-qwen35:9b-8k'),
    'via ollama (apograph-qwen35:9b-8k)',
  );
});

test('progress > literal "via local model" appears nowhere in the rendering layer', async () => {
  const modularSource = await readFile(
    fileURLToPath(new URL('../src/synthesizer/modular.ts', import.meta.url)),
    'utf8',
  );
  assert.ok(!modularSource.includes('via local model'));
  // The dynamic label builder is used by the stage labels instead.
  assert.ok(modularSource.includes('formatModelRouteLabel('));
});

// ---------------------------------------------------------------------------
// s8.5 - config > prompts are non-destructive
// ---------------------------------------------------------------------------

test('config > empty input preserves existing values', () => {
  const existing: ApographConfig = {
    provider: 'z-ai',
    model: 'glm-5.3-flash',
    apiKey: 'existing-key',
    baseUrl: 'https://api.z.ai/api/paas/v4',
  };

  // All-empty answers keep the existing typed values.
  const merged = mergePromptAnswers(existing, {
    provider: 'z-ai',
    model: '',
    apiKey: '',
    baseUrl: '',
  });
  assert.deepEqual(merged, existing);

  // Partial answers override only what was entered.
  const partial = mergePromptAnswers(existing, {
    provider: 'z-ai',
    model: 'glm-5.3-air',
    apiKey: '',
    baseUrl: '',
  });
  assert.equal(partial.model, 'glm-5.3-air');
  assert.equal(partial.apiKey, 'existing-key');
  assert.equal(partial.baseUrl, 'https://api.z.ai/api/paas/v4');
});

test('config > unknown keys survive save merges', () => {
  const existingRaw = {
    provider: 'ollama',
    model: 'apograph-qwen35:9b-8k',
    experimentalFeature: true,
    notes: ['hand-edited'],
  };

  const merged = mergeConfigWithUnknownKeys(existingRaw, {
    provider: 'z-ai',
    model: 'glm-5.3-flash',
    apiKey: 'sk-test',
    baseUrl: 'https://api.z.ai/api/paas/v4',
  });

  // Typed keys updated.
  assert.equal(merged.provider, 'z-ai');
  assert.equal(merged.model, 'glm-5.3-flash');
  // Unknown keys retained byte-for-value.
  assert.equal(merged.experimentalFeature, true);
  assert.deepEqual(merged.notes, ['hand-edited']);

  // A missing/corrupt file yields just the update (no crash).
  assert.deepEqual(mergeConfigWithUnknownKeys(null, { provider: 'ollama' }), {
    provider: 'ollama',
  });
});

test('config > GLM 5.3 Flash preset resolves correctly', () => {
  const preset = findVisionPreset('glm-5.3-flash');
  assert.notEqual(preset, null);
  assert.equal(preset?.provider, 'z-ai');
  assert.equal(preset?.model, 'glm-5.3-flash');

  // Fresh config: preset seeds provider, model, and default base URL.
  const fresh = applyVisionPreset('glm-5.3-flash', null);
  assert.equal(fresh.provider, 'z-ai');
  assert.equal(fresh.model, 'glm-5.3-flash');
  assert.equal(fresh.baseUrl, 'https://api.z.ai/api/paas/v4');

  // Existing config: base URL and API key are carried over as defaults.
  const carried = applyVisionPreset('glm-5.3-flash', {
    provider: 'gateway',
    apiKey: 'sk-existing',
    baseUrl: 'https://my-proxy.example.com/v1',
  });
  assert.equal(carried.provider, 'z-ai');
  assert.equal(carried.model, 'glm-5.3-flash');
  assert.equal(carried.baseUrl, 'https://my-proxy.example.com/v1');
  assert.equal(carried.apiKey, 'sk-existing');

  // Unknown preset rejected.
  assert.throws(() => applyVisionPreset('does-not-exist', null));
});

// ---------------------------------------------------------------------------
// z-ai provider alias resolution
// ---------------------------------------------------------------------------

test('config > z-ai alias maps to OpenAI-compatible gateway resolution', () => {
  const env: Record<string, string | undefined> = {};
  assert.equal(resolveProvider(env, { provider: 'z-ai' }), 'gateway');
  assert.equal(resolveProvider(env, { provider: 'gateway' }), 'gateway');
  assert.equal(resolveProvider(env, null), 'local');

  // Model id resolution: config model wins over provider default.
  assert.equal(resolveModelId('gateway', env, { provider: 'z-ai', model: 'glm-5.3-flash' }), 'glm-5.3-flash');
  // Env override wins over everything.
  assert.equal(
    resolveModelId('gateway', { APOGRAPH_MODEL: 'glm-5.3-air' }, { provider: 'z-ai', model: 'glm-5.3-flash' }),
    'glm-5.3-air',
  );
});

// ---------------------------------------------------------------------------
// Source-level bans
// ---------------------------------------------------------------------------

test('source > config command retains the GLM preset as a first-class option', async () => {
  const configSource = await readFile(
    join(fileURLToPath(new URL('../src/commands/config.ts', import.meta.url))),
    'utf8',
  );
  assert.ok(configSource.includes("'glm-5.3-flash'"));
  assert.ok(configSource.includes('VISION_PRESETS'));
  assert.ok(configSource.includes('mergePromptAnswers'));
});

// ---------------------------------------------------------------------------
// Emitted-project build resilience (verbatimModuleSyntax / TS1484)
// ---------------------------------------------------------------------------

test('scaffold > emitted tsconfig disables verbatimModuleSyntax and keeps isolatedModules', () => {
  const files = generateFrontendScaffold('demo-app');
  const tsconfig = files.find((file) => file.path === 'tsconfig.json');
  assert.ok(tsconfig !== undefined);
  const parsed = JSON.parse(tsconfig.content) as {
    compilerOptions: { verbatimModuleSyntax?: boolean; isolatedModules?: boolean };
  };
  assert.equal(
    parsed.compilerOptions.verbatimModuleSyntax,
    false,
    'type-only import quirks must not fail the emitted build (TS1484)',
  );
  assert.equal(parsed.compilerOptions.isolatedModules, true);
});

test('source > route pages own complete page architecture', async () => {
  const modularSource = await readFile(
    join(fileURLToPath(new URL('../src/synthesizer/modular.ts', import.meta.url))),
    'utf8',
  );
  assert.ok(modularSource.includes('Complete Page Architecture'));
  assert.ok(!modularSource.includes('Never render a <header> or <nav> inside route pages'));
});

test('source > system guidelines mandate type-only React imports', async () => {
  const modularSource = await readFile(
    join(fileURLToPath(new URL('../src/synthesizer/modular.ts', import.meta.url))),
    'utf8',
  );
  assert.ok(modularSource.includes('Always use type-only imports for React types'));
});

// ---------------------------------------------------------------------------
// Emitted-project build resilience (strict/noImplicitAny off, dev server bind)
// ---------------------------------------------------------------------------

test('scaffold > emitted tsconfig disables strict and noImplicitAny', () => {
  const files = generateFrontendScaffold('demo-app');
  const tsconfig = files.find((file) => file.path === 'tsconfig.json');
  assert.ok(tsconfig !== undefined);
  const parsed = JSON.parse(tsconfig.content) as {
    compilerOptions: { strict?: boolean; noImplicitAny?: boolean };
  };
  assert.equal(
    parsed.compilerOptions.strict,
    false,
    'minor LLM type quirks (e.g. TS2322) must not fail the emitted build',
  );
  assert.equal(
    parsed.compilerOptions.noImplicitAny,
    false,
    'implicit-any quirks must not fail the emitted build',
  );
});

test('scaffold > dev script uses Vite default host', () => {
  const files = generateFrontendScaffold('demo-app');
  const packageJson = files.find((file) => file.path === 'package.json');
  assert.ok(packageJson !== undefined);
  const parsed = JSON.parse(packageJson.content) as {
    scripts: { dev?: string };
  };
  assert.equal(parsed.scripts.dev, 'vite');
});

test('source > system guidelines forbid mixed icon name/component properties', async () => {
  const modularSource = await readFile(
    join(fileURLToPath(new URL('../src/synthesizer/modular.ts', import.meta.url))),
    'utf8',
  );
  assert.ok(
    modularSource.includes(
      'Never assign string names and component references to the same property',
    ),
    'lucide-react icon handling must be spelled out (TS2322 icon/ReactNode quirk)',
  );
  assert.ok(
    modularSource.includes('FOOTER CONTRACT'),
    'Footer contract must ban fixed/sticky/absolute positioning',
  );
  assert.ok(
    modularSource.includes('CARD IMAGES'),
    'Card images rule must ban assigning background crops or logos to cards',
  );
});

test('scaffold > vite config relaxes the port and binds loopback only', () => {
  const files = generateFrontendScaffold('demo-app');
  const viteConfig = files.find((file) => file.path === 'vite.config.ts');
  assert.ok(viteConfig !== undefined);
  assert.ok(viteConfig.content.includes('port: 5173'));
  assert.ok(viteConfig.content.includes('strictPort: false'));
  assert.ok(viteConfig.content.includes("host: '127.0.0.1'"));
});
