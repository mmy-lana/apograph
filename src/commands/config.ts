/**
 * apograph — Persistent configuration (`apograph config`, Phase 6).
 *
 * Stores provider settings in `~/.apograph/config.json` so the model route
 * survives across sessions without environment variables. Interactive menu
 * (@clack/prompts) for provider, model name, and API key; `--show` prints
 * the current configuration with the key masked.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as p from '@clack/prompts';

/** Supported LLM providers. */
export type ConfigProvider = 'ollama' | 'openai' | 'anthropic' | 'gateway';

/** The persisted configuration shape. */
export interface ApographConfig {
  provider: ConfigProvider;
  /** Model identifier (e.g. `gpt-4o`, `qwen2.5-coder:7b-instruct`). */
  model?: string;
  /** API key for the provider (not needed for local Ollama). */
  apiKey?: string;
  /** Base URL for a custom gateway/proxy (gateway provider only). */
  baseUrl?: string;
}

/** Absolute path of the config file. */
export function configFilePath(): string {
  return join(homedir(), '.apograph', 'config.json');
}

/** Default model per provider, used as prompt placeholder text. */
const PROVIDER_DEFAULTS: Record<ConfigProvider, string> = {
  ollama: 'qwen2.5-coder:7b-instruct',
  openai: 'gpt-4o',
  anthropic: 'claude-3-7-sonnet-latest',
  gateway: 'gpt-4o',
};

/**
 * Loads the persisted config, or null when absent or invalid. Missing
 * optional fields are tolerated; the shape is validated loosely so a
 * hand-edited file degrades instead of crashing the CLI.
 */
export function loadApographConfig(): ApographConfig | null {
  const path = configFilePath();

  if (!existsSync(path)) return null;

  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof raw !== 'object' || raw === null) return null;

    const candidate = raw as Partial<ApographConfig>;
    if (
      candidate.provider !== 'ollama' &&
      candidate.provider !== 'openai' &&
      candidate.provider !== 'anthropic' &&
      candidate.provider !== 'gateway'
    ) {
      return null;
    }

    return {
      provider: candidate.provider,
      ...(candidate.model !== undefined ? { model: candidate.model } : {}),
      ...(candidate.apiKey !== undefined ? { apiKey: candidate.apiKey } : {}),
      ...(candidate.baseUrl !== undefined ? { baseUrl: candidate.baseUrl } : {}),
    };
  } catch {
    return null;
  }
}

/** Persists the config to `~/.apograph/config.json`. */
export async function saveApographConfig(config: ApographConfig): Promise<string> {
  const path = configFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), 'utf8');
  return path;
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

  const provider = await p.select({
    message: 'Which provider should apograph use?',
    options: [
      { value: 'ollama' as const, label: 'Ollama (local)', hint: 'no API key required' },
      { value: 'openai' as const, label: 'OpenAI' },
      { value: 'anthropic' as const, label: 'Anthropic' },
      { value: 'gateway' as const, label: 'Custom gateway / proxy', hint: 'OpenAI-compatible endpoint' },
    ],
  });
  if (p.isCancel(provider)) {
    p.cancel('Configuration cancelled.');
    return;
  }

  const model = await p.text({
    message: 'Model name',
    placeholder: PROVIDER_DEFAULTS[provider],
    defaultValue: PROVIDER_DEFAULTS[provider],
  });
  if (p.isCancel(model)) {
    p.cancel('Configuration cancelled.');
    return;
  }

  let apiKey: string | undefined;
  if (provider !== 'ollama') {
    const key = await p.password({
      message: `API key for ${provider}`,
    });
    if (p.isCancel(key)) {
      p.cancel('Configuration cancelled.');
      return;
    }
    apiKey = key.length > 0 ? key : undefined;
  }

  let baseUrl: string | undefined;
  if (provider === 'gateway') {
    const url = await p.text({
      message: 'Gateway base URL',
      placeholder: 'https://your-gateway.example.com/v1',
      validate: (value) => {
        if (value === undefined || value.length === 0) {
          return 'A base URL is required for the gateway provider.';
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

  const config: ApographConfig = {
    provider,
    ...(model.length > 0 ? { model } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };

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
