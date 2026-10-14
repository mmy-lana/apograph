/**
 * apograph — Modular LLM provider resolution (Layer 5).
 *
 * Resolution order (each slot: environment first, then persisted config):
 *   1. Custom gateway/proxy: APOGRAPH_BASE_URL + APOGRAPH_API_KEY,
 *      or `apograph config` provider `gateway` (baseUrl + apiKey).
 *   2. Anthropic cloud:      ANTHROPIC_API_KEY,
 *      or config provider `anthropic`.
 *   3. OpenAI cloud:         OPENAI_API_KEY,
 *      or config provider `openai`.
 *   4. Local fallback:       Ollama at http://localhost:11434/v1,
 *      or config provider `ollama` (configurable model name).
 *
 * Environment variables always take precedence over `~/.apograph/config.json`.
 */

import { env } from 'node:process';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import { loadApographConfig } from '../commands/config.js';

const LOCAL_OLLAMA_BASE_URL = 'http://localhost:11434/v1';
const LOCAL_FALLBACK_MODEL = 'qwen2.5-coder:7b-instruct';

/** Default cloud model ids per provider. */
const PROVIDER_MODELS = {
  gateway: 'gpt-4o',
  anthropic: 'claude-3-7-sonnet-latest',
  openai: 'gpt-4o',
} as const;

/** The persisted config, read once per process (null when absent). */
const persistedConfig = loadApographConfig();

/**
 * Resolves which provider/alias is active, given the current environment
 * and the persisted config. Exported for diagnostics and tests; not part of
 * the model factory contract.
 */
export function resolveProviderName(): 'gateway' | 'anthropic' | 'openai' | 'local' {
  if (env.APOGRAPH_BASE_URL && env.APOGRAPH_API_KEY) return 'gateway';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.OPENAI_API_KEY) return 'openai';

  // Environment unset — fall back to the persisted config, if any.
  if (persistedConfig !== null) {
    if (persistedConfig.provider === 'gateway') return 'gateway';
    if (persistedConfig.provider === 'anthropic') return 'anthropic';
    if (persistedConfig.provider === 'openai') return 'openai';
  }

  return 'local';
}

/** Resolves the model id for a provider (env override > config > default). */
function resolveModelId(provider: 'gateway' | 'anthropic' | 'openai' | 'local'): string {
  if (env.APOGRAPH_MODEL !== undefined && env.APOGRAPH_MODEL.length > 0) {
    return env.APOGRAPH_MODEL;
  }
  if (persistedConfig?.model !== undefined && persistedConfig.model.length > 0) {
    return persistedConfig.model;
  }
  if (provider === 'local') return LOCAL_FALLBACK_MODEL;
  return PROVIDER_MODELS[provider];
}

/**
 * Resolves the primary LanguageModel for a role, following the precedence
 * order documented at the top of this module.
 */
export function getModel(): LanguageModel {
  const provider = resolveProviderName();

  if (provider === 'gateway') {
    const baseURL = env.APOGRAPH_BASE_URL ?? persistedConfig?.baseUrl;
    const apiKey = env.APOGRAPH_API_KEY ?? persistedConfig?.apiKey;

    if (baseURL === undefined || apiKey === undefined) {
      throw new Error(
        'Gateway provider is configured incompletely: both a base URL and an ' +
          'API key are required. Run `apograph config` or export ' +
          'APOGRAPH_BASE_URL / APOGRAPH_API_KEY.',
      );
    }

    const gateway = createOpenAI({ baseURL, apiKey });
    return gateway(resolveModelId('gateway'));
  }

  if (provider === 'anthropic') {
    const apiKey = env.ANTHROPIC_API_KEY ?? persistedConfig?.apiKey;
    if (apiKey === undefined) {
      throw new Error(
        'Anthropic provider selected but no API key found. Run `apograph config` ' +
          'or export ANTHROPIC_API_KEY.',
      );
    }

    const anthropic = createAnthropic({ apiKey });
    return anthropic(resolveModelId('anthropic'));
  }

  if (provider === 'openai') {
    const apiKey = env.OPENAI_API_KEY ?? persistedConfig?.apiKey;
    if (apiKey === undefined) {
      throw new Error(
        'OpenAI provider selected but no API key found. Run `apograph config` ' +
          'or export OPENAI_API_KEY.',
      );
    }

    const openai = createOpenAI({ apiKey });
    return openai(resolveModelId('openai'));
  }

  // Local dev fallback: Ollama exposes an OpenAI-compatible endpoint.
  const local = createOpenAI({
    baseURL: LOCAL_OLLAMA_BASE_URL,
    apiKey: env.OLLAMA_API_KEY ?? persistedConfig?.apiKey ?? 'ollama',
  });
  return local(resolveModelId('local'));
}

/** High-capability model used for final code synthesis (Layer 5). */
export function getSynthesizerModel(): LanguageModel {
  return getModel();
}

/** Cheap/fast model used for bulk parsing and classification tasks. */
export function getFastParserModel(): LanguageModel {
  return getModel();
}
