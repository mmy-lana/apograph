/**
 * apograph — Multimodal (vision) prompting pipeline (Phase 4).
 *
 * Loads the dual-viewport screenshots captured by the evidence crawl and
 * combines them with the a11y tree, design tokens, and the plan context into
 * image-bearing prompts for the Vercel AI SDK. Screenshots travel as base64
 * data URLs (`image:` parts), which every vision-capable provider accepts.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { A11yNode, CrawlRoute, DesignTokens, TextSpan } from '../types.js';
import { buildPromptParts, generateStructuredFilesFromParts } from './llm.js';
import type { PromptPart, SynthesisCallOptions } from './llm.js';
import type { ProjectFile } from '../types.js';

/** Max A11y tree depth serialized into prompts. */
const MAX_A11Y_DEPTH = 8;

/** Upper bound on screenshot bytes per prompt (protects context windows). */
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Screenshot loading
// ---------------------------------------------------------------------------

/** One loaded screenshot image. */
export interface ScreenshotImage {
  /** Base64 PNG data URL, ready for an AI SDK `image:` part. */
  dataUrl: string;
  /** Which viewport the shot came from. */
  viewport: 'desktop' | 'mobile';
}

/** Resolves a manifest screenshot path against the evidence directory. */
function resolveScreenshotPath(path: string, evidenceDir: string): string {
  if (path.startsWith('/')) return path;
  return resolve(evidenceDir, path);
}

/** Encodes a PNG file into a base64 data URL, or null if unreadable. */
async function loadScreenshotDataUrl(
  path: string,
  viewport: 'desktop' | 'mobile',
): Promise<ScreenshotImage | null> {
  try {
    const buffer = await readFile(path);
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_SCREENSHOT_BYTES) {
      return null;
    }
    return {
      dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
      viewport,
    };
  } catch {
    return null;
  }
}

/**
 * Loads a route's dual-viewport screenshots (desktop + mobile PNGs) from the
 * evidence bundle. Missing files and viewports that were not captured
 * (`null` paths) are silently skipped — the prompt then carries only the
 * surviving image(s).
 */
export async function loadRouteScreenshots(
  route: CrawlRoute,
  evidenceDir: string,
): Promise<ScreenshotImage[]> {
  const images: ScreenshotImage[] = [];

  if (route.desktopScreenshot !== null) {
    const desktop = await loadScreenshotDataUrl(
      resolveScreenshotPath(route.desktopScreenshot, evidenceDir),
      'desktop',
    );
    if (desktop) images.push(desktop);
  }

  if (route.mobileScreenshot !== null) {
    const mobile = await loadScreenshotDataUrl(
      resolveScreenshotPath(route.mobileScreenshot, evidenceDir),
      'mobile',
    );
    if (mobile) images.push(mobile);
  }

  return images;
}

// ---------------------------------------------------------------------------
// Prompt context serialization
// ---------------------------------------------------------------------------

/** Serializes an a11y tree into an indented `role "name" = value` outline. */
export function formatA11yTreeForVisionPrompt(
  node: A11yNode,
  depth: number = 0,
): string {
  const indent = '  '.repeat(depth);
  const label = node.name !== undefined ? ` "${node.name}"` : '';
  const value = node.value !== undefined ? ` = ${node.value}` : '';

  const lines = [`${indent}${node.role}${label}${value}`];
  if (depth < MAX_A11Y_DEPTH) {
    for (const child of node.children ?? []) {
      lines.push(formatA11yTreeForVisionPrompt(child, depth + 1));
    }
  }
  return lines.join('\n');
}

/** Maximum number of color values shown to the vision model (spec s4.3). */
export const MAX_PROMPT_COLORS = 24;

/**
 * Serializes design tokens into a compact prompt summary as a REDUCED
 * palette (spec s4.3): at most 24 unique color values with no indexed
 * `--color-apograph-N` variable enumeration (which measurably overwhelmed
 * the vision model and drove monochrome fallbacks), plus the canvas color.
 */
export function formatTokensForVisionPrompt(tokens: DesignTokens): string {
  const allValues = Object.values(tokens.colors);
  const uniqueColors = [...new Set(allValues)].slice(0, MAX_PROMPT_COLORS);
  const totalUnique = new Set(allValues).size;
  const colors = uniqueColors.map((value) => `  ${value}`).join('\n');
  const paletteNote =
    totalUnique > MAX_PROMPT_COLORS
      ? `\n  ... (${totalUnique - MAX_PROMPT_COLORS} more colors omitted; pick hues from the screenshots)`
      : '';

  const canvas = tokens.canvas?.backgroundColor;

  return [
    `Canvas background: ${canvas ?? 'not captured'}`,
    `Reduced palette (max ${MAX_PROMPT_COLORS} colors):\n${colors}${paletteNote}`,
    `Fonts: ${tokens.fonts.length > 0 ? tokens.fonts.slice(0, MAX_PROMPT_COLORS).join(', ') : '(none)'}`,
    `Spacing: ${tokens.spacing.length > 0 ? tokens.spacing.slice(0, MAX_PROMPT_COLORS).join(', ') : '(none)'}`,
    `Radii: ${tokens.radii.length > 0 ? tokens.radii.slice(0, MAX_PROMPT_COLORS).join(', ') : '(none)'}`,
  ].join('\n');
}

/** Serializes the mirrored-asset map for prompt embedding. */
export function formatAssetMapForPrompt(
  assets: Array<{ originalUrl: string; localPath: string | null; status: string }>,
): string {
  const downloaded = assets.filter(
    (asset) => asset.status === 'downloaded' && asset.localPath !== null,
  );
  if (downloaded.length === 0) return '(no mirrored assets)';

  return downloaded
    .map((asset) => {
      const filename = asset.localPath?.split('/').pop() ?? '';
      return `  /assets/${filename}  <-  ${asset.originalUrl}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Text corpus prompt formatting (spec s5.2)
// ---------------------------------------------------------------------------

/** Maximum text spans embedded in a single prompt (guards context size). */
export const MAX_PROMPT_TEXT_SPANS = 200;

/**
 * Formats the harvested text corpus for prompt embedding (spec s5.2):
 * spans are sorted by vertical visual position (boundingBox.top ASC) so they
 * match the natural top-to-bottom reading order of the screenshot, falling
 * back to original document index when coordinates are absent or identical.
 */
export function formatTextSpansForPrompt(spans: TextSpan[]): string {
  if (spans.length === 0) return 'Text corpus: (not captured)';

  const ranked = spans
    .map((span, index) => ({ span, index }))
    .sort((a, b) => {
      const topA = a.span.boundingBox?.top ?? 0;
      const topB = b.span.boundingBox?.top ?? 0;
      return topA - topB || a.index - b.index;
    })
    .slice(0, MAX_PROMPT_TEXT_SPANS);

  const lines = ranked.map(({ span }) => {
    const tag = span.parentTag !== span.tag ? `${span.parentTag}>${span.tag}` : span.tag;
    const gradient = span.gradient !== undefined ? ` [gradient: ${span.gradient}]` : '';
    return `  [${tag}] ${span.text}${gradient}`;
  });

  const truncated =
    ranked.length < spans.length ? `\n  ... (${spans.length - ranked.length} more spans omitted)` : '';

  return [
    'Text corpus (visible DOM text ordered top-to-bottom). Use this text to',
    'populate headings and copy accurately matching each section\'s visual hierarchy.',
    'Gradient headline spans MUST keep their exact gradient definition:',
    ...lines,
    truncated,
  ]
    .join('\n')
    .replace(/\n$/, '');
}

// ---------------------------------------------------------------------------
// Vision synthesis call
// ---------------------------------------------------------------------------

/**
 * Generates project files from a vision prompt: the text context plus the
 * route's screenshots as AI SDK image parts. Screenshots are ordered
 * desktop-first; the text block always comes last so models that weight the
 * final text segment see the instructions after the images. Optional
 * `options` threads the bounded-retry hooks (model override, spinner
 * updates) into the underlying synthesis call.
 */
export async function generateFilesWithVision(
  text: string,
  systemPrompt: string,
  screenshots: ScreenshotImage[],
  options: SynthesisCallOptions = {},
): Promise<ProjectFile[]> {
  const parts: PromptPart[] = buildPromptParts(
    text,
    screenshots.map((shot) => ({ dataUrl: shot.dataUrl })),
  );

  return generateStructuredFilesFromParts(parts, systemPrompt, options);
}

/** Joins the evidence directory with its screenshots subdirectory. */
export function screenshotsDirOf(evidenceDir: string): string {
  return join(evidenceDir, 'screenshots');
}

// ---------------------------------------------------------------------------
// Closed-loop visual diff repair (spec s7)
// ---------------------------------------------------------------------------

/**
 * Builds the localized multimodal repair prompt (spec s7): the reference
 * screenshot and the pixelmatch diff overlay are embedded as image parts
 * (reference first, diff overlay second, text last), and the text instructs
 * a targeted correction of the failing component — not a re-synthesis.
 * Pure and exported for testing.
 */
export function buildVisualRepairPrompt(
  componentPath: string,
  mismatchPercent: number,
): { text: string; systemPrompt: string } {
  const text = [
    `The component at ${componentPath} failed visual verification with a`,
    `${mismatchPercent.toFixed(2)}% pixel mismatch against the reference site.`,
    '',
    'The FIRST image is the original reference screenshot; the SECOND image',
    'is the pixelmatch diff overlay — highlighted regions mark exactly where',
    'the synthesized output diverges from the reference.',
    '',
    'Repair ONLY the localized styling discrepancies visible in the diff',
    'overlay: spacing, padding, margins, colors, gradients, font sizes and',
    'weights, container alignment, and visibility. Do NOT rewrite unrelated',
    'code, do NOT restructure the component, do NOT change imports, props,',
    'state logic, or event handlers, and do NOT truncate the file.',
    '',
    `Emit exactly one file — ${componentPath} — with the complete,`,
    'compile-ready corrected content.',
  ].join('\n');

  const systemPrompt = [
    'You are a surgical frontend repair agent. You receive one React',
    'component and a pixelmatch diff overlay against the reference site.',
    'Apply the minimum targeted styling corrections indicated by the diff.',
    'Respond with the complete corrected file content only: no markdown',
    'fences, no commentary, no truncation. Preserve everything the diff does',
    'not implicate.',
  ].join(' ');

  return { text, systemPrompt };
}

/**
 * Runs one single-turn visual diff repair (spec s7): sends the current
 * component source, the original reference screenshot, and the pixelmatch
 * diff overlay to the vision model and returns the corrected file content.
 */
export async function repairComponentWithVisualDiff(
  componentPath: string,
  currentCode: string,
  originalScreenshotDataUrl: string,
  diffImageDataUrl: string,
  mismatchPercent: number,
): Promise<string> {
  const { text, systemPrompt } = buildVisualRepairPrompt(componentPath, mismatchPercent);

  const parts: PromptPart[] = buildPromptParts(
    `${text}\n\nCurrent content of ${componentPath}:\n${currentCode}`,
    [
      { dataUrl: originalScreenshotDataUrl },
      { dataUrl: diffImageDataUrl },
    ],
  );

  const files = await generateStructuredFilesFromParts(parts, systemPrompt);
  const repaired = files.find((file) => file.path === componentPath) ?? files[0];
  if (repaired === undefined || repaired.content.trim().length === 0) {
    throw new Error(`Visual repair for ${componentPath} returned no file content.`);
  }
  return repaired.content;
}
