/**
 * apograph — Modular LLM provider resolution (Layer 5).
 *
 * Resolution order:
 *   1. Custom gateway/proxy: APOGRAPH_BASE_URL + APOGRAPH_API_KEY
 *   2. Anthropic cloud:      ANTHROPIC_API_KEY
 *   3. OpenAI cloud:         OPENAI_API_KEY
 *   4. Local fallback:       Ollama at http://localhost:11434/v1
 */

import { env } from 'node:process';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';

const LOCAL_OLLAMA_BASE_URL = 'http://localhost:11434/v1';
const LOCAL_FALLBACK_MODEL = 'qwen2.5-coder:7b-instruct';

/**
 * Resolves which provider/alias is active, given the current environment.
 * Exported for diagnostics and tests; not part of the model factory contract.
 */
export function resolveProviderName(): 'gateway' | 'anthropic' | 'openai' | 'local' {
  if (env.APOGRAPH_BASE_URL && env.APOGRAPH_API_KEY) return 'gateway';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.OPENAI_API_KEY) return 'openai';
  return 'local';
}

/**
 * Resolves the primary LanguageModel for a role, following the precedence
 * order documented at the top of this module.
 */
export function getModel(): LanguageModel {
  const provider = resolveProviderName();

  if (provider === 'gateway') {
    const gateway = createOpenAI({
      baseURL: env.APOGRAPH_BASE_URL,
      apiKey: env.APOGRAPH_API_KEY,
    });
    return gateway(env.APOGRAPH_MODEL ?? 'gpt-4o');
  }

  if (provider === 'anthropic') {
    const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
    return anthropic('claude-3-7-sonnet-latest');
  }

  if (provider === 'openai') {
    const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
    return openai('gpt-4o');
  }

  // Local dev fallback: Ollama exposes an OpenAI-compatible endpoint.
  const local = createOpenAI({
    baseURL: LOCAL_OLLAMA_BASE_URL,
    apiKey: env.OLLAMA_API_KEY ?? 'ollama',
  });
  return local(LOCAL_FALLBACK_MODEL);
}

/** High-capability model used for final code synthesis (Layer 5). */
export function getSynthesizerModel(): LanguageModel {
  return getModel();
}

/** Cheap/fast model used for bulk parsing and classification tasks. */
export function getFastParserModel(): LanguageModel {
  return getModel();
}
