/**
 * apograph — Persistent configuration (`apograph config`, Phase 6).
 *
 * Stores provider settings in `~/.apograph/config.json` so the model route
 * survives across sessions without environment variables. Interactive menu
 * (@clack/prompts) for provider, model name, and API key; `--show` prints
 * the current configuration with the key masked.
 */

import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as p from '@clack/prompts';

/** Supported LLM providers. `z-ai` is an alias of `gateway` (OpenAI-compatible). */
export type ConfigProvider = 'ollama' | 'openai' | 'anthropic' | 'gateway' | 'z-ai';

/** The persisted configuration shape. */
export interface ApographConfig {
  provider: ConfigProvider;
  /** Model identifier (e.g. `gpt-4o`, `glm-5.3-flash`, `apograph-qwen35:9b-8k`). */
  model?: string;
  /** API key for the provider (not needed for local Ollama). */
  apiKey?: string;
  /** Base URL for a custom gateway/proxy (gateway / z-ai provider only). */
  baseUrl?: string;
}

/** A first-class cloud vision preset (spec s6.2). */
export interface VisionPreset {
  id: string;
  label: string;
  hint: string;
  provider: ConfigProvider;
  model: string;
  defaultBaseUrl: string;
}

/**
 * First-class vision presets selectable in `apograph config` (spec s6.2).
 * The GLM 5.3 Flash preset makes the dark-canvas SPA-class OpenAI-compatible
 * gateway a selection rather than manual assembly.
 */
export const VISION_PRESETS: VisionPreset[] = [
  {
    id: 'glm-5.3-flash',
    label: 'GLM 5.3 Flash (z-ai gateway)',
    hint: 'OpenAI-compatible cloud vision gateway',
    provider: 'z-ai',
    model: 'glm-5.3-flash',
    defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
  },
];

/** Finds a preset by id (null when unknown). */
export function findVisionPreset(id: string): VisionPreset | null {
  return VISION_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * Applies a vision preset on top of the existing config (spec s6.2): the
 * preset fixes provider and model defaults; the existing base URL and API
 * key are carried over as defaults so empty prompt input keeps them.
 */
export function applyVisionPreset(
  presetId: string,
  existing: ApographConfig | null,
): ApographConfig {
  const preset = findVisionPreset(presetId);
  if (preset === null) {
    throw new Error(`Unknown vision preset: ${presetId}`);
  }
  return {
    provider: preset.provider,
    model: preset.model,
    ...(existing?.baseUrl !== undefined ? { baseUrl: existing.baseUrl } : { baseUrl: preset.defaultBaseUrl }),
    ...(existing?.apiKey !== undefined ? { apiKey: existing.apiKey } : {}),
  };
}

/**
 * Merges prompted answers over the existing config, non-destructively
 * (spec s6.2): an empty answer (empty string) keeps the existing value,
 * and unknown keys in the persisted file are preserved by
 * {@link mergeConfigWithUnknownKeys}.
 */
export function mergePromptAnswers(
  existing: ApographConfig | null,
  answers: {
    provider: ConfigProvider;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  },
): ApographConfig {
  const model = answers.model !== undefined && answers.model.length > 0
    ? answers.model
    : existing?.model;
  const apiKey = answers.apiKey !== undefined && answers.apiKey.length > 0
    ? answers.apiKey
    : existing?.apiKey;
  const baseUrl = answers.baseUrl !== undefined && answers.baseUrl.length > 0
    ? answers.baseUrl
    : existing?.baseUrl;

  return {
    provider: answers.provider,
    ...(model !== undefined ? { model } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

/**
 * Merges a typed config update into the raw persisted JSON, preserving any
 * unknown keys (spec s6.2: `apograph config` never rewrites a config file
 * it did not intentionally change).
 */
export function mergeConfigWithUnknownKeys(
  existingRaw: unknown,
  update: ApographConfig,
): Record<string, unknown> {
  const base =
    typeof existingRaw === 'object' && existingRaw !== null && !Array.isArray(existingRaw)
      ? (existingRaw as Record<string, unknown>)
      : {};
  return { ...base, ...update };
}

/** Absolute path of the config file. */
export function configFilePath(): string {
  return join(homedir(), '.apograph', 'config.json');
}

/** Default model per provider, used as prompt placeholder text. */
const PROVIDER_DEFAULTS: Record<ConfigProvider, string> = {
  ollama: 'apograph-qwen35:9b-8k',
  openai: 'gpt-4o',
  anthropic: 'claude-3-7-sonnet-latest',
  gateway: 'gpt-4o',
  'z-ai': 'glm-5.3-flash',
};

/** True when a raw provider value is a supported ConfigProvider. */
export function isConfigProvider(value: unknown): value is ConfigProvider {
  return (
    value === 'ollama' ||
    value === 'openai' ||
    value === 'anthropic' ||
    value === 'gateway' ||
    value === 'z-ai'
  );
}

/**
 * Parses raw config JSON into the typed shape, or null when the shape is
 * invalid or the provider is unknown. Missing optional fields are tolerated
 * so a hand-edited file degrades instead of crashing the CLI.
 */
export function parseApographConfig(raw: unknown): ApographConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const candidate = raw as Partial<ApographConfig>;
  if (!isConfigProvider(candidate.provider)) {
    return null;
  }
  for (const key of ['model', 'apiKey', 'baseUrl'] as const) {
    if (candidate[key] !== undefined && typeof candidate[key] !== 'string') return null;
  }

  return {
    provider: candidate.provider,
    ...(candidate.model !== undefined ? { model: candidate.model } : {}),
    ...(candidate.apiKey !== undefined ? { apiKey: candidate.apiKey } : {}),
    ...(candidate.baseUrl !== undefined ? { baseUrl: candidate.baseUrl } : {}),
  };
}

/**
 * Loads the persisted config, or null when absent or invalid. Missing
 * optional fields are tolerated; the shape is validated loosely so a
 * hand-edited file degrades instead of crashing the CLI.
 */
export function loadApographConfig(): ApographConfig | null {
  const path = configFilePath();

  if (!existsSync(path)) return null;

  try {
    return parseApographConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/** Writes a complete config atomically with restrictive permissions. */
async function writeConfigAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (cause) {
    try { await unlink(temp); } catch { /* best effort cleanup */ }
    throw cause;
  }
}

/**
 * Persists the config to `~/.apograph/config.json`, merging over the raw
 * file so unknown keys survive the update (spec s6.2, non-destructive).
 */
export async function saveApographConfig(config: ApographConfig): Promise<string> {
  const path = configFilePath();

  let existingRaw: unknown = null;
  if (existsSync(path)) {
    try {
      existingRaw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      existingRaw = null;
    }
  }

  const merged = mergeConfigWithUnknownKeys(existingRaw, config);
  await writeConfigAtomically(path, JSON.stringify(merged, null, 2));
  return path;
}

// ---------------------------------------------------------------------------
// Non-interactive updates (`apograph config set --model <id>`)
// ---------------------------------------------------------------------------

/** Options for {@link runConfigSetCommand}. */
export interface ConfigSetCliOptions {
  /** The model ID to persist (`--model <id>`). */
  model?: string;
  /** Overrides the config file location (tests inject a temp path). */
  configPath?: string;
}

/** Result of a non-interactive model update. */
export interface ConfigModelUpdate {
  path: string;
  model: string;
}

/**
 * Non-interactively updates ONLY the `model` field of the persisted config
 * (`apograph config set --model <id>`). Every other field — including
 * unknown keys — survives via {@link mergeConfigWithUnknownKeys}, and no
 * prompts are shown. Throws an actionable error when no model is given or
 * when the config file is missing/unparseable, so a corrupt file is never
 * silently rewritten.
 */
export async function setConfigModel(
  model: string,
  configPath?: string,
): Promise<ConfigModelUpdate> {
  if (model.length === 0) {
    throw new Error('No model specified. Usage: apograph config set --model <id>');
  }

  const path = configPath ?? configFilePath();

  let existingRaw: unknown = null;
  if (existsSync(path)) {
    try {
      existingRaw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new Error(
        `Could not parse ${path} as JSON. Fix (or delete) the file, then run \`apograph config\` first.`,
      );
    }
  }

  const existing = parseApographConfig(existingRaw);
  if (existing === null) {
    throw new Error(
      `No valid configuration found at ${path}. Run \`apograph config\` first to configure a provider, then set the model.`,
    );
  }

  const merged = mergeConfigWithUnknownKeys(existingRaw, { ...existing, model });
  await writeConfigAtomically(path, JSON.stringify(merged, null, 2));

  return { path, model };
}

/** Runs `apograph config set --model <id>` (no interactive prompts). */
export async function runConfigSetCommand(options: ConfigSetCliOptions): Promise<void> {
  const model = typeof options.model === 'string' ? options.model : '';
  const updated = await setConfigModel(model, options.configPath);
  console.log(`Model updated to: ${updated.model}`);
}

/** Masks an API key for display (keeps the first 4 and last 2 characters). */
function maskKey(key: string): string {
  if (key.length <= 6) return '******';
  return `${key.slice(0, 4)}${'*'.repeat(Math.max(4, key.length - 6))}${key.slice(-2)}`;
}

/** Options for {@link runConfigCommand}. */
export interface ConfigCliOptions {
  /** Print the current configuration and exit (no prompts). */
  show: boolean;
}

/** Runs the `apograph config` command. */
export async function runConfigCommand(options: ConfigCliOptions): Promise<void> {
  if (options.show) {
    const current = loadApographConfig();
    if (current === null) {
      console.log(`No configuration found at ${configFilePath()}.`);
      console.log('Run `apograph config` to create one interactively.');
      return;
    }

    console.log(`Configuration (${configFilePath()}):`);
    console.log(`  Provider: ${current.provider}`);
    if (current.model !== undefined) console.log(`  Model:    ${current.model}`);
    if (current.apiKey !== undefined) console.log(`  API key:  ${maskKey(current.apiKey)}`);
    if (current.baseUrl !== undefined) console.log(`  Base URL: ${current.baseUrl}`);
    return;
  }

  p.intro('apograph config — LLM provider settings');

  const existing = loadApographConfig();

  // Provider selection: first-class presets (spec s6.2) plus raw providers.
  const selection = await p.select({
    message: 'Which vision provider should apograph use? (empty input keeps existing values)',
    initialValue: existing?.provider,
    options: [
      ...VISION_PRESETS.map((preset) => ({
        value: `preset:${preset.id}`,
        label: preset.label,
        hint: preset.hint,
      })),
      { value: 'ollama' as const, label: 'Ollama (local)', hint: 'no API key required' },
      { value: 'openai' as const, label: 'OpenAI' },
      { value: 'anthropic' as const, label: 'Anthropic' },
      { value: 'gateway' as const, label: 'Custom gateway / proxy', hint: 'OpenAI-compatible endpoint' },
    ],
  });
  if (p.isCancel(selection)) {
    p.cancel('Configuration cancelled.');
    return;
  }

  // Preset selection seeds provider, model, and base URL defaults.
  const presetAnswer = selection.startsWith('preset:')
    ? findVisionPreset(selection.slice('preset:'.length))
    : null;
  const presetConfig = presetAnswer !== null ? applyVisionPreset(presetAnswer.id, existing) : null;
  const provider: ConfigProvider =
    presetConfig?.provider ?? (selection as ConfigProvider);
  const modelDefault =
    presetConfig?.model ?? existing?.model ?? PROVIDER_DEFAULTS[provider];
  const baseUrlDefault = presetConfig?.baseUrl ?? existing?.baseUrl;

  const model = await p.text({
    message: 'Model name (empty keeps the default)',
    placeholder: modelDefault,
    defaultValue: modelDefault,
  });
  if (p.isCancel(model)) {
    p.cancel('Configuration cancelled.');
    return;
  }

  let apiKey: string | undefined;
  if (provider !== 'ollama') {
    const key = await p.password({
      message:
        existing?.apiKey !== undefined
          ? `API key for ${provider} (empty keeps the existing key)`
          : `API key for ${provider}`,
    });
    if (p.isCancel(key)) {
      p.cancel('Configuration cancelled.');
      return;
    }
    apiKey = key;
  }

  let baseUrl: string | undefined;
  if (provider === 'gateway' || provider === 'z-ai') {
    const url = await p.text({
      message: 'Gateway base URL (empty keeps the existing value)',
      placeholder: baseUrlDefault ?? 'https://your-gateway.example.com/v1',
      defaultValue: baseUrlDefault,
      validate: (value) => {
        // Empty input keeps the existing/default base URL.
        if (value === undefined || value.length === 0) {
          if (baseUrlDefault === undefined) {
            return 'A base URL is required for the gateway provider.';
          }
          return undefined;
        }
        try {
          new URL(value);
          return undefined;
        } catch {
          return 'Enter a valid http(s) URL.';
        }
      },
    });
    if (p.isCancel(url)) {
      p.cancel('Configuration cancelled.');
      return;
    }
    baseUrl = url;
  }

  const config = mergePromptAnswers(existing, {
    provider,
    ...(model !== undefined ? { model } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });

  const confirm = await p.confirm({
    message: `Save configuration to ${configFilePath()}?`,
    initialValue: true,
  });
  if (p.isCancel(confirm) || !confirm) {
    p.cancel('Configuration cancelled.');
    return;
  }

  const savedPath = await saveApographConfig(config);
  p.outro(`Configuration saved to ${savedPath}.`);
  console.log('Environment variables (when set) still take precedence.');
}
