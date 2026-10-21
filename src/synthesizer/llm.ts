/**
 * apograph — LLM synthesis primitives (Layer 5: Orchestration).
 *
 * File generation uses a markdown file-section contract (`### File: <path>`
 * followed by a fenced code block) extracted with a robust regex parser —
 * never JSON string fields, whose escaping corrupts multi-thousand-line
 * React sources ("Bad escaped character in JSON at position X"). A lenient,
 * escape-repaired JSON extraction remains only as a legacy fallback for
 * models that still answer in the old shape. Prompts may carry image parts
 * for multimodal (vision) synthesis — see `src/synthesizer/vision.ts`.
 */

import { generateText } from 'ai';
import type { ImagePart, LanguageModel, TextPart } from 'ai';
import type { ProjectFile } from '../types.js';
import { getSynthesizerModel, getFastParserModel } from '../config/models.js';
import { redactSecrets } from '../config/validate.js';

// ---------------------------------------------------------------------------
// File emission contract
// ---------------------------------------------------------------------------

/** Maximum length of an emitted file path (mirrors the old schema bound). */
const MAX_FILE_PATH_LENGTH = 240;

/** Maximum length of an emitted file's content (mirrors the old schema bound). */
const MAX_FILE_CONTENT_LENGTH = 1_000_000;

/** Maximum number of files accepted from one generation response. */
const MAX_FILES_PER_RESPONSE = 200;

/** The schema-safe project-relative path rule (no absolute paths, no `..`). */
const SAFE_FILE_PATH_RE = /^(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[^\x00\r\n]+$/;

/** True when `path` is a safe, project-relative file path. */
export function isSafeProjectFilePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= MAX_FILE_PATH_LENGTH &&
    SAFE_FILE_PATH_RE.test(path)
  );
}

/**
 * Prompt contract appended to every generation turn: files travel as
 * markdown file sections with fenced code blocks, never inside JSON string
 * fields.
 */
export const FILE_EMISSION_CONTRACT = [
  'Respond with the generated files as markdown file sections in exactly this format:',
  '### File: <project-relative/path>',
  '```tsx',
  '<complete file content>',
  '```',
  'Emit one section per file. Keep every file complete and compile-ready.',
  'Do not wrap file contents in a JSON object or JSON string fields.',
].join('\n');

/** Stricter one-shot re-extraction instruction for unparseable first replies. */
const FILE_EXTRACTION_TURN_CONTRACT = [
  'Your previous response could not be used: it contained no files in the required format.',
  'Return ONLY the generated files as markdown file sections in exactly this format:',
  '### File: <project-relative/path>',
  '```tsx',
  '<complete file content>',
  '```',
  'One section per file. No JSON, no commentary, no truncation.',
].join('\n');

/**
 * Hard per-stage timeout cap for one model request (180 s). An upstream
 * model that hangs or streams slower than acceptable aborts the stage
 * cleanly instead of holding the pipeline for 15+ minutes. Override via
 * `APOGRAPH_LLM_TIMEOUT_MS` for slower local models — still capped.
 */
export const MAX_STAGE_TIMEOUT_MS = 180_000;

/** Default per-stage timeout when no override is configured (180 s). */
const DEFAULT_LLM_TIMEOUT_MS = MAX_STAGE_TIMEOUT_MS;

/**
 * Resolves the effective per-stage generation timeout: the configured
 * `APOGRAPH_LLM_TIMEOUT_MS` (or the 180 s default) clamped to
 * {@link MAX_STAGE_TIMEOUT_MS}. Exported for tests.
 */
export function resolveLlmTimeoutMs(): number {
  const configured = Number.parseInt(process.env.APOGRAPH_LLM_TIMEOUT_MS ?? '', 10);
  const timeout = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_LLM_TIMEOUT_MS;
  return Math.min(timeout, MAX_STAGE_TIMEOUT_MS);
}

function llmTimeoutSignal(): AbortSignal {
  return AbortSignal.timeout(resolveLlmTimeoutMs());
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
  // A 2xx body the provider-utils response parser could not read ("Invalid
  // JSON response") is a transient provider/gateway fault — bounded retries
  // give the upstream a clean second chance. 4xx semantics are unchanged.
  if (isProviderBodyParseFailure(error) && (status === null || (status >= 200 && status < 300))) {
    return 'retry';
  }
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
  /**
   * Single-file fallback path: when a reply carries no parseable file
   * sections (e.g. a repair turn answering with raw corrected content), the
   * whole reply is taken as this file. Multi-file generation leaves it unset.
   */
  defaultFilePath?: string;
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
 * True when the provider's response body failed JSON parsing
 * (`@ai-sdk/provider-utils` throws `APICallError("Invalid JSON response")`
 * when a gateway returns a body its response schema cannot read — e.g. an
 * error payload masked behind HTTP 200, or a large completion truncated
 * mid-body). Distinct from model-output parse failures; the retry policy
 * treats 2xx instances as transient provider faults.
 */
function isProviderBodyParseFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /invalid json response/i.test(error.message);
}

/**
 * True when a generation failed at the protocol level — the model (or its
 * gateway) answered but no usable payload came back: a structured-output
 * rejection (`NoObjectGeneratedError`, AI SDK `JSONParseError` /
 * `TypeValidationError`), or a provider body-parse failure. These are
 * capability/protocol failures, not fatal errors: the pipeline must salvage
 * the returned text or spend one bounded extraction turn instead of
 * abandoning the stage.
 */
function isStructuredProtocolFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (
    error.name === 'AI_NoObjectGeneratedError' ||
    error.name === 'AI_JSONParseError' ||
    error.name === 'AI_TypeValidationError'
  ) {
    return true;
  }
  return (
    /no object generated/i.test(error.message) ||
    isProviderBodyParseFailure(error) ||
    /type validation failed|failed to parse json|json parse error/i.test(error.message)
  );
}

/**
 * Attempts to salvage generated files from the raw text a failed generation
 * already produced: the AI SDK attaches model output to
 * `NoObjectGeneratedError.text` / `JSONParseError.text`, and provider body
 * parse failures carry the raw `responseBody`. Salvage is deliberately
 * conservative — the same robust extractor runs, but without the bare-text
 * single-file fallback. Returns null when no usable payload exists; callers
 * then spend one bounded extraction turn.
 */
function salvageGeneratedFiles(cause: unknown): ProjectFile[] | null {
  const source = cause as { text?: unknown; responseBody?: unknown };
  for (const candidate of [source.text, source.responseBody]) {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) continue;
    const files = parseGeneratedFiles(candidate);
    if (files.length > 0) return files;
  }
  return null;
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
// Robust file extraction (markdown file sections, legacy JSON fallback)
// ---------------------------------------------------------------------------

/**
 * A file section header line, e.g. `### File: src/pages/HomePage.tsx`.
 * Tolerates heading depth 0–6, an optional `File`/`File path` label, bold
 * markers, and trailing punctuation-free paths.
 */
const FILE_SECTION_HEADER_RE =
  /^#{0,6}[ \t]*(?:\*\*)?[Ff]ile(?:[ \t]+path)?[ \t]*:?[ \t]+(\S[^\n]*?)[ \t]*$/gm;

/**
 * A fenced code block whose closing fence is at least three backticks
 * (tolerates models that close a ``` fence with ````). The content is the
 * raw file body — no JSON escaping involved.
 */
const FENCED_FILE_BODY_RE =
  /```[a-zA-Z0-9_+.-]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*`{3,}[ \t]*(?=\r?\n|$)/;

/** Strips wrapping bold markers / backticks / quotes from a captured path. */
function cleanFilePath(raw: string): string {
  return raw
    .trim()
    .replace(/^\*+|\*+$/g, '')
    .replace(/^`+|`+$/g, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

/**
 * Extracts files from the markdown file-section contract: each
 * `### File: <path>` header followed by a fenced code block. Sections with
 * unsafe paths or missing bodies are skipped; never throws.
 */
export function parseFileSections(text: string): ProjectFile[] {
  const headerRe = new RegExp(FILE_SECTION_HEADER_RE.source, 'gm');
  const headers: Array<{ path: string; index: number; bodyStart: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(text)) !== null) {
    const path = cleanFilePath(match[1] ?? '');
    if (isSafeProjectFilePath(path)) {
      headers.push({ path, index: match.index, bodyStart: match.index + match[0].length });
    }
  }

  const files: ProjectFile[] = [];
  for (let i = 0; i < headers.length && files.length < MAX_FILES_PER_RESPONSE; i += 1) {
    const current = headers[i] as { path: string; index: number; bodyStart: number };
    const next = headers[i + 1];
    const region = text.slice(current.bodyStart, next !== undefined ? next.index : text.length);
    const body = FENCED_FILE_BODY_RE.exec(region);
    const content = body?.[1]?.replace(/\s+$/, '');
    if (content === undefined || content.length === 0) continue;
    if (content.length > MAX_FILE_CONTENT_LENGTH) continue;
    files.push({ path: current.path, content });
  }
  return files;
}

/**
 * Repairs invalid JSON string escapes (`\d`, `\x`, lone backslashes) so a
 * legacy model response can still be parsed instead of crashing with
 * "Bad escaped character in JSON at position X". Valid escapes are kept.
 */
function repairJsonEscapes(raw: string): string {
  return raw.replace(/\\(?!["\\/bfnrt]|u[0-9a-fA-F]{4})/g, '\\\\');
}

/** Parses a JSON payload leniently (strict parse first, then escape repair). */
function lenientJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(repairJsonEscapes(raw));
  }
}

/**
 * Legacy fallback: extracts `{"files": [{"path", "content"}]}` payloads from
 * models that still answer with JSON. Parsing is lenient (invalid string
 * escapes are repaired first), never throws, and enforces the same path and
 * size bounds as the markdown contract.
 */
function parseLegacyJsonFiles(text: string): ProjectFile[] {
  let payload: unknown;
  try {
    payload = lenientJsonParse(extractJsonBlock(text));
  } catch {
    return [];
  }

  const record = payload as { files?: unknown } | unknown[];
  const rawFiles = Array.isArray(record) ? record : record.files;
  if (!Array.isArray(rawFiles)) return [];

  const files: ProjectFile[] = [];
  for (const entry of rawFiles.slice(0, MAX_FILES_PER_RESPONSE)) {
    const candidate = entry as { path?: unknown; content?: unknown };
    if (typeof candidate.path !== 'string' || typeof candidate.content !== 'string') continue;
    const path = cleanFilePath(candidate.path);
    if (!isSafeProjectFilePath(path)) continue;
    if (candidate.content.length > MAX_FILE_CONTENT_LENGTH) continue;
    files.push({ path, content: candidate.content });
  }
  return files;
}

/**
 * Extracts generated project files from raw model output. Order:
 *
 * 1. Markdown file sections (`### File: <path>` + fenced code block) — the
 *    primary contract; raw content, zero JSON escaping.
 * 2. Legacy `{"files": [...]}` JSON payloads (lenient, escape-repaired).
 * 3. When `defaultPath` is set and nothing above matched, the whole
 *    response (fences stripped) is taken as that single file — used by
 *    single-file repair turns.
 *
 * Never throws: unusable output yields an empty list.
 */
export function parseGeneratedFiles(
  text: string,
  options: { defaultPath?: string } = {},
): ProjectFile[] {
  const sections = parseFileSections(text);
  if (sections.length > 0) return sections;

  const legacy = parseLegacyJsonFiles(text);
  if (legacy.length > 0) return legacy;

  const fallbackPath = options.defaultPath;
  if (fallbackPath !== undefined && isSafeProjectFilePath(fallbackPath)) {
    const content = stripFences(text);
    if (content.length > 0 && content.length <= MAX_FILE_CONTENT_LENGTH) {
      return [{ path: fallbackPath, content }];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Markdown-contract file generation
// ---------------------------------------------------------------------------

/**
 * Generates a set of project files from a prompt (with optional image parts)
 * using the markdown file-section contract (see
 * {@link FILE_EMISSION_CONTRACT}): one `### File: <path>` header plus a
 * fenced code block per file — never JSON string fields.
 *
 * Responses are extracted with the robust regex parser
 * ({@link parseGeneratedFiles}); a legacy `{"files": [...]}` payload is
 * still accepted leniently. When the first reply is unusable, one bounded
 * extraction turn re-asks with a stricter instruction; a second unusable
 * reply raises. Protocol failures (unsupported structured output, provider
 * body-parse faults) first attempt salvage from the raw response text/body.
 * The whole call runs inside the single bounded transient retry policy
 * (429/502/503/408 and transient 2xx body-parse faults retried, 401/403
 * abort the run, everything else raises).
 */
export async function generateStructuredFilesFromParts(
  parts: PromptPart[],
  systemPrompt?: string,
  options: SynthesisCallOptions = {},
): Promise<ProjectFile[]> {
  const model = options.model ?? getSynthesizerModel();
  const parseOptions =
    options.defaultFilePath !== undefined ? { defaultPath: options.defaultFilePath } : {};
  let extractionTurnUsed = false;

  const request = (instruction: string): Promise<{ text: string }> =>
    generateText({
      model,
      maxRetries: 0,
      abortSignal: llmTimeoutSignal(),
      ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
      messages: [
        {
          role: 'user',
          content: [...parts, { type: 'text' as const, text: `\n\n${instruction}` }],
        },
      ],
    });

  return withTransientRetry(async () => {
    try {
      const result = await request(FILE_EMISSION_CONTRACT);
      const files = parseGeneratedFiles(result.text, parseOptions);
      if (files.length > 0) return files;
    } catch (cause) {
      // Salvage files the failed call already produced before paying for a
      // second generation round-trip.
      const salvaged = salvageGeneratedFiles(cause);
      if (salvaged !== null) return salvaged;

      const recoverable =
        isStructuredOutputUnsupported(cause) || isStructuredProtocolFailure(cause);
      if (!recoverable || extractionTurnUsed) throw cause;
    }

    // The reply carried no usable files: one bounded extraction turn per
    // call, then the stage fails explicitly.
    if (extractionTurnUsed) {
      throw new Error(
        'model response contained no usable project files ' +
          '(expected `### File: <path>` markdown sections with fenced code blocks)',
      );
    }
    extractionTurnUsed = true;

    const retry = await request(FILE_EXTRACTION_TURN_CONTRACT);
    const files = parseGeneratedFiles(retry.text, parseOptions);
    if (files.length > 0) return files;
    throw new Error(
      'model response contained no usable project files ' +
        '(expected `### File: <path>` markdown sections with fenced code blocks)',
    );
  }, options);
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
