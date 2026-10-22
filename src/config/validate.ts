/**
 * apograph — Provider validation and capability detection (MODEL-02/03).
 *
 * Pre-flight checks for the active provider configuration plus lightweight
 * structured-output and vision probes. All functions are pure/injectable so
 * unit tests never touch the network or real credentials, and every message
 * passes through secret redaction before it reaches a caller.
 *
 * This module never changes pipeline behavior: probes only *report*; the
 * runtime fallbacks in `src/synthesizer/llm.ts` stay authoritative.
 */

import { generateObject, generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import type { ApographConfig } from '../commands/config.js';
import { resolveProvider, resolveModelId } from './models.js';

export type ProviderName = 'gateway' | 'anthropic' | 'openai' | 'local';

/** Error/diagnostic classes distinguishable by validation. */
export type ProviderIssueClass =
  | 'missing-credentials'
  | 'malformed-url'
  | 'unreachable'
  | 'auth-rejection'
  | 'model-mismatch';

/** One validation check result. `status: 'warn'` never blocks the pipeline. */
export interface ProviderCheck {
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  issueClass: ProviderIssueClass | null;
  fix: string | null;
}

/** Full validation report for the active provider configuration. */
export interface ProviderValidation {
  provider: ProviderName;
  modelId: string;
  /** Masked credential indicator (e.g. `sk-a****ef`), or null when absent. */
  credentialHint: string | null;
  baseUrl: string | null;
  checks: ProviderCheck[];
  /** True when no check has status 'fail'. */
  ok: boolean;
}

/** Typed capability report for one resolved model. */
export interface ModelCapabilities {
  structuredOutput: boolean;
  vision: boolean;
  error?: string;
}

/** Injected dependencies for {@link validateProviderConfig}. */
export interface ValidateOptions {
  env?: NodeJS.ProcessEnv;
  config?: ApographConfig | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

/** Matches secret token shapes (sk/pk/rk keys, bearer tokens, JWTs, vendor tokens). */
const SECRET_SHAPE_RE =
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{6,}\b|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9._~+/=-]{10,}|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{6,}\b|\bxox[a-z]-[A-Za-z0-9-]{6,}\b/gi;

/**
 * Masks a single secret for display: keeps the first 4 and last 2
 * characters (e.g. `sk-a****ef`); fully masks anything 6 characters or
 * shorter. Mirrors the shape used by `apograph config --show`.
 */
export function maskSecret(secret: string): string {
  if (secret.length <= 6) return '******';
  return `${secret.slice(0, 4)}${'*'.repeat(Math.max(4, secret.length - 6))}${secret.slice(-2)}`;
}

/**
 * Removes any secret-looking substrings from free-form text (error messages,
 * diagnostic dumps). Additionally masks a caller-provided secret so a
 * provider echoing credentials back can never leak them into output.
 */
export function redactSecrets(text: string, ...secrets: string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join(maskSecret(secret));
  }
  return redacted.replace(SECRET_SHAPE_RE, (match) => maskSecret(match));
}

// ---------------------------------------------------------------------------
// Configuration validation (MODEL-02)
// ---------------------------------------------------------------------------

/** The active provider/model/credential resolution, mirroring models.ts. */
export function resolveActiveProvider(
  env: NodeJS.ProcessEnv = process.env,
  config: ApographConfig | null = null,
): { provider: ProviderName; modelId: string; apiKey: string | undefined; baseUrl: string | undefined } {
  const provider = resolveProvider(env, config);
  const modelId = resolveModelId(provider, env, config);

  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  if (provider === 'gateway') {
    baseUrl = env.APOGRAPH_BASE_URL ?? config?.baseUrl;
    apiKey = env.APOGRAPH_API_KEY ?? config?.apiKey;
  } else if (provider === 'anthropic') {
    apiKey = env.ANTHROPIC_API_KEY ?? config?.apiKey;
  } else if (provider === 'openai') {
    apiKey = env.OPENAI_API_KEY ?? config?.apiKey;
  } else {
    apiKey = env.OLLAMA_API_KEY ?? config?.apiKey;
  }

  return { provider, modelId, apiKey, baseUrl };
}

/** Model-id/family consistency heuristic (warn-only; gateways remap freely). */
function modelFamilyWarning(provider: ProviderName, modelId: string): ProviderCheck | null {
  const lower = modelId.toLowerCase();
  if (provider === 'anthropic' && !lower.startsWith('claude')) {
    return {
      label: 'Model id matches provider family',
      status: 'warn',
      detail: `anthropic provider selected but model "${modelId}" is not a claude-* id`,
      issueClass: 'model-mismatch',
      fix: 'Set APOGRAPH_MODEL or the config `model` field to a claude-* id (unless your proxy remaps ids).',
    };
  }
  if (provider === 'openai' && !/^(gpt|o\d)/.test(lower)) {
    return {
      label: 'Model id matches provider family',
      status: 'warn',
      detail: `openai provider selected but model "${modelId}" does not look like an OpenAI id`,
      issueClass: 'model-mismatch',
      fix: 'Set APOGRAPH_MODEL or the config `model` field to a gpt-*/o* id (unless your proxy remaps ids).',
    };
  }
  return null;
}

/**
 * Validates the active provider configuration. Never throws: every failure
 * mode becomes a check with a class and a fix. Network probing happens only
 * for the gateway route (`GET {baseUrl}/models`, warn-only) and is fully
 * injectable for tests. All messages are secret-redacted.
 */
export async function validateProviderConfig(options: ValidateOptions = {}): Promise<ProviderValidation> {
  const env = options.env ?? process.env;
  const config = options.config !== undefined ? options.config : null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;

  const { provider, modelId, apiKey, baseUrl } = resolveActiveProvider(env, config);
  const checks: ProviderCheck[] = [];
  const allSecrets = [apiKey, env.APOGRAPH_API_KEY, env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY]
    .filter((value): value is string => typeof value === 'string');

  const credentialHint = apiKey !== undefined && apiKey.length > 0 ? maskSecret(apiKey) : null;

  const addPresenceCheck = (required: boolean): void => {
    if (apiKey !== undefined && apiKey.length > 0) {
      checks.push({
        label: 'API key present',
        status: 'pass',
        detail: `credential stored (${maskSecret(apiKey)})`,
        issueClass: null,
        fix: null,
      });
    } else {
      checks.push({
        label: 'API key present',
        status: required ? 'fail' : 'warn',
        detail: required ? 'no API key found in environment or ~/.apograph/config.json' : 'no credential stored (not required for local Ollama)',
        issueClass: required ? 'missing-credentials' : null,
        fix: required
          ? `Run \`apograph config\` or export ${provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'}.`
          : null,
      });
    }
  };

  if (provider === 'gateway') {
    // baseUrl + apiKey are both required (spec MODEL-02).
    if (apiKey === undefined || apiKey.length === 0) {
      checks.push({
        label: 'API key present',
        status: 'fail',
        detail: 'gateway provider requires an API key (env APOGRAPH_API_KEY or config apiKey)',
        issueClass: 'missing-credentials',
        fix: 'Run `apograph config` (provider: gateway) or export APOGRAPH_API_KEY.',
      });
    } else {
      checks.push({
        label: 'API key present',
        status: 'pass',
        detail: `credential stored (${maskSecret(apiKey)})`,
        issueClass: null,
        fix: null,
      });
    }

    if (baseUrl === undefined || baseUrl.length === 0) {
      checks.push({
        label: 'Base URL present',
        status: 'fail',
        detail: 'gateway provider requires a base URL (env APOGRAPH_BASE_URL or config baseUrl)',
        issueClass: 'missing-credentials',
        fix: 'Run `apograph config` (provider: gateway) or export APOGRAPH_BASE_URL.',
      });
    } else {
      let parsed: URL | null = null;
      try {
        parsed = new URL(baseUrl);
      } catch {
        parsed = null;
      }
      if (parsed === null || !/^https?:$/.test(parsed.protocol)) {
        checks.push({
          label: 'Base URL well-formed',
          status: 'fail',
          detail: `"${redactSecrets(baseUrl, ...allSecrets)}" is not a valid http(s) URL`,
          issueClass: 'malformed-url',
          fix: 'Set APOGRAPH_BASE_URL (or the config baseUrl) to a full http(s) endpoint, e.g. https://gateway.example.com/v1.',
        });
      } else {
        checks.push({
          label: 'Base URL well-formed',
          status: 'pass',
          detail: parsed.host,
          issueClass: null,
          fix: null,
        });

        // Reachability + auth probe: GET {baseUrl}/models (OpenAI-compatible).
        try {
          const response = await fetchImpl(new URL('models', parsed).toString(), {
            headers: { Authorization: `Bearer ${apiKey ?? ''}` },
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (response.status === 401 || response.status === 403) {
            checks.push({
              label: 'Gateway endpoint reachable',
              status: 'fail',
              detail: `endpoint rejected the credential (HTTP ${response.status})`,
              issueClass: 'auth-rejection',
              fix: 'Verify the API key for this gateway, then re-run `apograph doctor`.',
            });
          } else if (!response.ok) {
            checks.push({
              label: 'Gateway endpoint reachable',
              status: 'warn',
              detail: `endpoint responded HTTP ${response.status} to GET /models`,
              issueClass: 'unreachable',
              fix: 'Confirm the endpoint implements the OpenAI-compatible /models route; continuing anyway.',
            });
          } else {
            checks.push({
              label: 'Gateway endpoint reachable',
              status: 'pass',
              detail: 'GET /models succeeded',
              issueClass: null,
              fix: null,
            });
          }
        } catch (cause) {
          const reason = redactSecrets(cause instanceof Error ? cause.message : String(cause), ...allSecrets);
          checks.push({
            label: 'Gateway endpoint reachable',
            status: 'warn',
            detail: `could not reach the endpoint: ${reason}`,
            issueClass: 'unreachable',
            fix: 'Check network access / the gateway URL; the pipeline will fail at first synthesis if it stays unreachable.',
          });
        }
      }
    }
  } else if (provider === 'anthropic' || provider === 'openai') {
    addPresenceCheck(true);
  } else {
    addPresenceCheck(false);
  }

  if (provider !== 'gateway') {
    const familyCheck = modelFamilyWarning(provider, modelId);
    if (familyCheck !== null) checks.push(familyCheck);
  }

  return {
    provider,
    modelId,
    credentialHint,
    baseUrl: baseUrl ?? null,
    checks,
    ok: checks.every((check) => check.status !== 'fail'),
  };
}

// ---------------------------------------------------------------------------
// Capability probes (MODEL-03)
// ---------------------------------------------------------------------------

/** 1×1 red PNG — enough to prove image input without meaningful payload. */
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Report-only schema for the structured-output probe. */
const ProbeSchema = z.object({ ok: z.boolean() });

/**
 * Probes one resolved model for structured output and vision support
 * (MODEL-03). Report-only: results never change pipeline behavior. Errors
 * are captured, secret-redacted, and truncated; a probe failure is a
 * capability `false`, never a crash.
 */
export async function probeModelCapabilities(
  model: LanguageModel,
  options: { timeoutMs?: number } = {},
): Promise<ModelCapabilities> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const abortSignal = AbortSignal.timeout(timeoutMs);
  let firstError: string | undefined;

  let structuredOutput = false;
  try {
    const result = await generateObject({
      model,
      schema: ProbeSchema,
      prompt: 'Reply with the JSON object {"ok": true}.',
      abortSignal,
      maxTokens: 64,
    });
    structuredOutput = typeof result.object?.ok === 'boolean';
  } catch (cause) {
    structuredOutput = false;
    firstError = truncate(redactSecrets(cause instanceof Error ? cause.message : String(cause)));
  }

  let vision = false;
  try {
    const result = await generateText({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', image: TINY_PNG_DATA_URL },
            { type: 'text', text: 'Reply with exactly: OK' },
          ],
        },
      ],
      abortSignal,
      maxTokens: 16,
    });
    vision = result.text.trim().length > 0;
  } catch (cause) {
    vision = false;
    firstError = firstError ?? truncate(redactSecrets(cause instanceof Error ? cause.message : String(cause)));
  }

  return firstError === undefined ? { structuredOutput, vision } : { structuredOutput, vision, error: firstError };
}

/** Keeps diagnostic messages short (redaction happens before truncation). */
function truncate(text: string, max = 240): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
