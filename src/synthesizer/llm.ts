/**
 * apograph — LLM synthesis primitives (Layer 5: Orchestration).
 *
 * Structured file generation via `generateObject` with a graceful
 * `generateText` fallback for models that lack native json_schema support,
 * plus a token-frugal code repair helper. Prompts may carry image parts for
 * multimodal (vision) synthesis — see `src/synthesizer/vision.ts`.
 */

import { generateObject, generateText } from 'ai';
import { z } from 'zod';
import type { ImagePart, LanguageModel, TextPart } from 'ai';
import type { ProjectFile } from '../types.js';
import { getSynthesizerModel, getFastParserModel } from '../config/models.js';
import { redactSecrets } from '../config/validate.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Contract for LLM-emitted project files. */
const GeneratedProjectSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().min(1).max(240).regex(/^(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[^\x00\r\n]+$/),
      content: z.string().max(1000000),
    }),
  ).max(200),
});

/** The parsed payload of {@link GeneratedProjectSchema}. */
type GeneratedProject = z.infer<typeof GeneratedProjectSchema>;

/**
 * Hard upper bound for one model request. The previous implementation had no
 * abort signal, so a stalled gateway could hold a paid request indefinitely.
 * Override for slower local models, but keep the bound finite.
 */
const DEFAULT_LLM_TIMEOUT_MS = 10 * 60 * 1000;

function llmTimeoutSignal(): AbortSignal {
  const configured = Number.parseInt(process.env.APOGRAPH_LLM_TIMEOUT_MS ?? '', 10);
  const timeout = Number.isFinite(configured) && configured > 0
    ? Math.min(configured, 30 * 60 * 1000)
    : DEFAULT_LLM_TIMEOUT_MS;
  return AbortSignal.timeout(timeout);
}

// ---------------------------------------------------------------------------
// Bounded transient retry policy
// ---------------------------------------------------------------------------

/** Maximum attempts per synthesis call (initial attempt included). */
export const MAX_ATTEMPTS = 3;

/** Hard cap on total backoff wait time across all retries of one call. */
export const BACKOFF_BUDGET_MS = 90_000;

/**
 * Backoff schedule: after failed attempt N, wait `baseMs ± jitterMs`.
 * With MAX_ATTEMPTS = 3 the loop consumes the first two slots between its
 * three attempts; the third entry documents the terminal slot of the policy
 * schedule and backs the exported policy helper.
 */
export const BACKOFF_SCHEDULE: ReadonlyArray<{ baseMs: number; jitterMs: number }> = [
  { baseMs: 3_000, jitterMs: 500 },
  { baseMs: 7_000, jitterMs: 1_000 },
  { baseMs: 15_000, jitterMs: 1_500 },
];

/** Transient status codes worth retrying (bounded). */
const RETRYABLE_STATUS = new Set([429, 502, 503, 408]);

/** Auth status codes: abort the run, never retry, never fall back. */
const AUTH_STATUS = new Set([401, 403]);

/** Socket-level error codes that mark a transient network dropout. */
const NETWORK_RESET_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Message fragments that mark a transient network/socket dropout. */
const NETWORK_RESET_MESSAGES = ['fetch failed', 'read econnreset'];

/**
 * Fatal provider authentication failure (HTTP 401/403). Thrown instead of a
 * deterministic fallback so an invalid credential can never masquerade as a
 * successfully degraded clone — callers abort the run with this error.
 */
export class ProviderAuthError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, detail: string) {
    super(
      `Provider credential rejected (HTTP ${statusCode}): ${detail} — ` +
        'verify the API key (`apograph config --show`) or the ' +
        'APOGRAPH_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY environment ' +
        'variable, then re-run.',
    );
    this.name = 'ProviderAuthError';
    this.statusCode = statusCode;
  }
}

/** How the retry policy reacts to one failed attempt. */
export type RetryDecision = 'retry' | 'auth-abort' | 'raise';

/**
 * Follows RetryError-style shells (`lastError` / `errors[]`) down to the
 * underlying provider error so status/header extraction can never be
 * blinded by wrapper errors. Bounded to a short chain.
 */
function unwrapProviderError(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    const lastError = (current as { lastError?: unknown } | null)?.lastError;
    if (lastError !== undefined && lastError !== null) {
      current = lastError;
      continue;
    }
    const errors = (current as { errors?: unknown } | null)?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      current = errors[errors.length - 1];
      continue;
    }
    break;
  }
  return current;
}

/** Reads a numeric `statusCode` off a provider error, or null. */
function extractStatusCode(error: unknown): number | null {
  const status = (unwrapProviderError(error) as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' ? status : null;
}

/** Reads a `Retry-After` hint (ms) off a provider error, or null. */
function extractRetryAfterMs(error: unknown): number | null {
  const headers = (unwrapProviderError(error) as { responseHeaders?: unknown } | null)
    ?.responseHeaders;
  if (typeof headers !== 'object' || headers === null) return null;
  const record = headers as Record<string, unknown>;
  const raw = record['retry-after'] ?? record['Retry-After'];
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(0, raw * 1000);
  }
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
}

/** True when an error is an abort/timeout (terminal — never retried). */
function isAbortLike(error: unknown): boolean {
  const candidate = error as { name?: unknown; isAbortError?: unknown } | null;
  return (
    candidate?.name === 'AbortError' ||
    candidate?.name === 'TimeoutError' ||
    candidate?.isAbortError === true
  );
}

/**
 * True when an error is a transient network/socket dropout (`ECONNRESET`,
 * `ETIMEDOUT`, `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`, or a `fetch
 * failed` / `read ECONNRESET` message). Inspects `error.code`, the code on
 * `error.cause`, and `error.message` — including inside RetryError-style
 * wrappers. Such dropouts are retryable backoff candidates.
 */
export function isNetworkResetError(error: unknown): boolean {
  const candidates: unknown[] = [error];
  const unwrapped = unwrapProviderError(error);
  if (unwrapped !== error) candidates.push(unwrapped);

  for (const candidate of candidates) {
    const record = candidate as { code?: unknown; cause?: { code?: unknown } } | null;
    if (typeof record?.code === 'string' && NETWORK_RESET_CODES.has(record.code)) {
      return true;
    }
    const causeCode = record?.cause?.code;
    if (typeof causeCode === 'string' && NETWORK_RESET_CODES.has(causeCode)) {
      return true;
    }
    const message = (
      candidate instanceof Error ? candidate.message : String(candidate ?? '')
    ).toLowerCase();
    if (NETWORK_RESET_MESSAGES.some((fragment) => message.includes(fragment))) {
      return true;
    }
  }
  return false;
}

/**
 * Classifies one failed attempt:
 * - abort/timeout expiry is terminal (`raise`);
 * - 401/403 abort the run (`auth-abort`);
 * - network/socket dropouts are transient (`retry`, reason `network-reset`);
 * - 429/502/503/408 are transient (`retry`);
 * - everything else (400/404/500/unknown) raises immediately.
 */
export function classifyProviderError(error: unknown): RetryDecision {
  if (isAbortLike(error)) return 'raise';

  const status = extractStatusCode(error);
  if (status !== null && AUTH_STATUS.has(status)) return 'auth-abort';
  if (isNetworkResetError(error)) return 'retry';
  if (status !== null && RETRYABLE_STATUS.has(status)) return 'retry';
  return 'raise';
}

/**
 * Backoff wait for a failed `attempt` (1-based): `baseMs ± jitterMs` from
 * {@link BACKOFF_SCHEDULE}, deterministically driven by the injectable
 * `random` (0 -> base - jitter, 1 -> base + jitter).
 */
export function computeBackoffMs(attempt: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(attempt, 1), BACKOFF_SCHEDULE.length) - 1;
  const slot = BACKOFF_SCHEDULE[index] as { baseMs: number; jitterMs: number };
  return Math.round(slot.baseMs + (random() * 2 - 1) * slot.jitterMs);
}

/** Injectable collaborators for the retry loop (tests use deterministic fakes). */
export interface TransientRetryOptions {
  /** Receives a user-facing message before each retry wait (spinner hook). */
  onRetry?: (message: string) => void;
  /** Sleep primitive for retry waits. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** RNG for backoff jitter. Defaults to Math.random. */
  random?: () => number;
}

/** Options accepted by synthesis calls; extends the retry hooks with a model. */
export interface SynthesisCallOptions extends TransientRetryOptions {
  /** Model override (tests inject a deterministic mock). */
  model?: LanguageModel;
}

/**
 * Runs one synthesis attempt inside the single bounded transient retry loop:
 * at most {@link MAX_ATTEMPTS} attempts, exponential backoff with jitter,
 * `Retry-After` honored when present (clamped to the remaining budget), and a
 * hard {@link BACKOFF_BUDGET_MS} total-wait cap. `maxRetries: 0` stays set on
 * the underlying AI SDK calls — retries never stack. HTTP 401/403 raise
 * {@link ProviderAuthError} immediately; abort/timeout expiry is terminal.
 */
export async function withTransientRetry<T>(
  run: (attempt: number) => Promise<T>,
  options: TransientRetryOptions = {},
): Promise<T> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const random = options.random ?? Math.random;
  let waitedMs = 0;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run(attempt);
    } catch (cause) {
      const decision = classifyProviderError(cause);

      if (decision === 'auth-abort') {
        throw new ProviderAuthError(
          extractStatusCode(cause) ?? 401,
          redactSecrets(cause instanceof Error ? cause.message : String(cause)),
        );
      }
      if (decision !== 'retry' || attempt >= MAX_ATTEMPTS) throw cause;

      const remainingMs = BACKOFF_BUDGET_MS - waitedMs;
      if (remainingMs <= 0) throw cause;

      // Retry-After (bounded) wins over the computed backoff.
      const requestedMs = extractRetryAfterMs(cause) ?? computeBackoffMs(attempt, random);
      const waitMs = Math.min(requestedMs, remainingMs);
      waitedMs += waitMs;

      options.onRetry?.(
        `Gateway at capacity — retrying in ${Math.round(waitMs / 1000)}s ` +
          `(attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
      );
      await sleep(waitMs);
    }
  }
}

/** One prompt part: text or an image (base64 data URL). */
export type PromptPart = TextPart | ImagePart;

/** Builds prompt parts from a text block plus optional image data URLs. */
export function buildPromptParts(
  text: string,
  images: Array<{ dataUrl: string }>,
): PromptPart[] {
  const parts: PromptPart[] = images.map((image) => ({
    type: 'image' as const,
    image: image.dataUrl,
  }));
  parts.push({ type: 'text' as const, text });
  return parts;
}

// ---------------------------------------------------------------------------
// Fallback detection
// ---------------------------------------------------------------------------

/**
 * True when an error looks like a 400 / unsupported-parameter rejection from
 * a provider or proxy that cannot handle native `json_schema` structured
 * output (common with local SLMs served over OpenAI-compatible endpoints).
 */
function isStructuredOutputUnsupported(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  const status = (error as unknown as { status?: unknown }).status;
  const hasStatus = typeof status === 'number' && status === 400;
  const mentionsParameter =
    message.includes('unsupported') ||
    message.includes('not supported') ||
    message.includes('invalid schema') ||
    message.includes('json_schema') ||
    message.includes('response_format') ||
    message.includes('unknown parameter') ||
    message.includes('unrecognized request argument');

  return hasStatus || mentionsParameter || message.includes('400');
}

/**
 * True when the model responded but no structured object could be produced —
 * typically the AI SDK's `NoObjectGeneratedError` ("the tool was not
 * called"), raised when a model answers with prose instead of invoking the
 * structured-output tool. This is a protocol capability failure, not a
 * transient provider fault: the pipeline must fall back to raw-text JSON
 * extraction instead of abandoning the stage.
 */
function isNoObjectGeneratedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AI_NoObjectGeneratedError' || /no object generated/i.test(error.message);
}

/**
 * Attempts to salvage generated files from the raw text a failed structured
 * generation already produced (the AI SDK attaches it to
 * `NoObjectGeneratedError.text`). Returns null when there is no usable
 * payload; callers then fall back to a fresh `generateText` extraction.
 */
function salvageGeneratedFiles(cause: unknown): ProjectFile[] | null {
  const text = (cause as { text?: unknown }).text;
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  try {
    const parsed: GeneratedProject = GeneratedProjectSchema.parse(
      JSON.parse(extractJsonBlock(text)),
    );
    return parsed.files.length > 0 ? parsed.files : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Markdown fence extraction
// ---------------------------------------------------------------------------

/** Matches the first fenced code block (with or without a language tag). */
const FENCED_BLOCK_RE = /```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?\s*```/;

/** Strips a single pair of leading/trailing markdown fences, if present. */
function stripFences(text: string): string {
  const trimmed = text.trim();

  const fenced = FENCED_BLOCK_RE.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();

  return trimmed;
}

/** Extracts the first JSON-looking payload from raw model output. */
function extractJsonBlock(text: string): string {
  // Prefer an explicitly fenced ```json block.
  const jsonFence = /```json\s*\n([\s\S]*?)\n?\s*```/i.exec(text);
  if (jsonFence?.[1]) return jsonFence[1].trim();

  // Then any fenced block.
  const anyFence = FENCED_BLOCK_RE.exec(text);
  if (anyFence?.[1]) return anyFence[1].trim();

  // Then a bare {...} or [...] span.
  const bare = /(\{[\s\S]*\}|\[[\s\S]*\])/.exec(text);
  if (bare?.[1]) return bare[1].trim();

  return text.trim();
}

// ---------------------------------------------------------------------------
// Structured file generation
// ---------------------------------------------------------------------------

/**
 * Generates a set of project files from a prompt (with optional image parts)
 * using structured output.
 *
 * Prefers `generateObject` with the `project_files` schema. When the model
 * rejects native `json_schema` structured output (400 / unsupported
 * parameter — typical of local SLMs and OpenAI-compatible proxies) or
 * answers without invoking the structured tool (`NoObjectGeneratedError`),
 * falls back to salvaging the returned text, then to `generateText` with
 * JSON block extraction out of the raw response.
 * The whole call runs inside the single bounded transient retry policy
 * (429/502/503/408 retried, 401/403 abort the run, everything else raises).
 */
export async function generateStructuredFilesFromParts(
  parts: PromptPart[],
  systemPrompt?: string,
  options: SynthesisCallOptions = {},
): Promise<ProjectFile[]> {
  const model = options.model ?? getSynthesizerModel();
  let structuredUnsupported = false;

  return withTransientRetry(async () => {
    if (!structuredUnsupported) {
      try {
        const result = await generateObject({
          model,
          schema: GeneratedProjectSchema,
          schemaName: 'project_files',
          maxRetries: 0,
          abortSignal: llmTimeoutSignal(),
          ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
          messages: [{ role: 'user', content: parts }],
        });

        return result.object.files;
      } catch (cause) {
        // Salvage files the failed structured call already produced before
        // paying for a second generation round-trip.
        const salvaged = isNoObjectGeneratedError(cause) ? salvageGeneratedFiles(cause) : null;
        if (salvaged !== null) return salvaged;

        const unsupported = isStructuredOutputUnsupported(cause);
        const noObject = isNoObjectGeneratedError(cause);
        if (!unsupported && !noObject) throw cause;

        // Protocol capability fallback — not a transient failure; subsequent
        // retry attempts skip straight to the generateText path.
        structuredUnsupported = true;
        console.warn(
          unsupported
            ? '[apograph] structured output unsupported by model; ' +
                'falling back to generateText JSON extraction.'
            : '[apograph] model produced no structured object; ' +
                'falling back to generateText JSON extraction.',
        );
      }
    }

    const textResult = await generateText({
      model,
      maxRetries: 0,
      abortSignal: llmTimeoutSignal(),
      ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
      messages: [
        {
          role: 'user',
          content: [
            ...parts,
            {
              type: 'text' as const,
              text:
                '\n\nRespond with ONLY a JSON object of the form ' +
                '{"files": [{"path": "<file path>", "content": "<full file content>"}]}. ' +
                'No markdown fences, no commentary, no extra keys.',
            },
          ],
        },
      ],
    });

    const parsed: GeneratedProject = GeneratedProjectSchema.parse(
      JSON.parse(extractJsonBlock(textResult.text)),
    );

    return parsed.files;
  }, options);
}

/**
 * Generates a set of project files from a plain text prompt. See
 * {@link generateStructuredFilesFromParts} for the multimodal variant.
 */
export async function generateStructuredFiles(
  prompt: string,
  systemPrompt?: string,
  options: SynthesisCallOptions = {},
): Promise<ProjectFile[]> {
  return generateStructuredFilesFromParts(
    [{ type: 'text', text: prompt }],
    systemPrompt,
    options,
  );
}

// ---------------------------------------------------------------------------
// Code repair
// ---------------------------------------------------------------------------

/**
 * Repairs a failing source file using the fast/cheap parser model to keep
 * token usage minimal. The model receives the current content plus the exact
 * compiler/linter errors and must return the corrected raw file content
 * only — any markdown fences are stripped before returning. Runs inside the
 * single bounded transient retry policy shared with synthesis.
 */
export async function repairCodeFile(
  filePath: string,
  currentContent: string,
  errors: string[],
  options: SynthesisCallOptions = {},
): Promise<string> {
  const model = options.model ?? getFastParserModel();

  const errorList =
    errors.length > 0 ? errors.map((error, index) => `${index + 1}. ${error}`).join('\n') : '(none)';

  return withTransientRetry(async () => {
    const result = await generateText({
      model,
      maxRetries: 0,
      abortSignal: llmTimeoutSignal(),
      system:
        'You are a code repair agent. You receive one source file and a list of ' +
        'compiler or linter errors. Respond with ONLY the corrected raw file ' +
        'content. Zero markdown fences, zero explanations, zero commentary. ' +
        'Do not truncate. Preserve all parts of the file that are not implicated ' +
        'by the errors.',
      prompt:
        `File: ${filePath}\n\n` +
        `Errors:\n${errorList}\n\n` +
        `Current content:\n${currentContent}\n\n` +
        'Return the full corrected file content only.',
    });

    return stripFences(result.text);
  }, options);
}
