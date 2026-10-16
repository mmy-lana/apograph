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
import type { ImagePart, TextPart } from 'ai';
import type { ProjectFile } from '../types.js';
import { getSynthesizerModel, getFastParserModel } from '../config/models.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Contract for LLM-emitted project files. */
const GeneratedProjectSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().min(1),
      content: z.string(),
    }),
  ),
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
 * parameter — typical of local SLMs and OpenAI-compatible proxies), falls
 * back to `generateText` and parses the JSON block out of the raw response.
 */
export async function generateStructuredFilesFromParts(
  parts: PromptPart[],
  systemPrompt?: string,
): Promise<ProjectFile[]> {
  const model = getSynthesizerModel();

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
    if (!isStructuredOutputUnsupported(cause)) throw cause;

    console.warn(
      '[apograph] structured output unsupported by model; ' +
        'falling back to generateText JSON extraction.',
    );

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
  }
}

/**
 * Generates a set of project files from a plain text prompt. See
 * {@link generateStructuredFilesFromParts} for the multimodal variant.
 */
export async function generateStructuredFiles(
  prompt: string,
  systemPrompt?: string,
): Promise<ProjectFile[]> {
  return generateStructuredFilesFromParts(
    [{ type: 'text', text: prompt }],
    systemPrompt,
  );
}

// ---------------------------------------------------------------------------
// Code repair
// ---------------------------------------------------------------------------

/**
 * Repairs a failing source file using the fast/cheap parser model to keep
 * token usage minimal. The model receives the current content plus the exact
 * compiler/linter errors and must return the corrected raw file content
 * only — any markdown fences are stripped before returning.
 */
export async function repairCodeFile(
  filePath: string,
  currentContent: string,
  errors: string[],
): Promise<string> {
  const model = getFastParserModel();

  const errorList =
    errors.length > 0 ? errors.map((error, index) => `${index + 1}. ${error}`).join('\n') : '(none)';

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
}
