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
import type { A11yNode, CrawlRoute, DesignTokens } from '../types.js';
import { buildPromptParts, generateStructuredFilesFromParts } from './llm.js';
import type { PromptPart } from './llm.js';
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
// Vision synthesis call
// ---------------------------------------------------------------------------

/**
 * Generates project files from a vision prompt: the text context plus the
 * route's screenshots as AI SDK image parts. Screenshots are ordered
 * desktop-first; the text block always comes last so models that weight the
 * final text segment see the instructions after the images.
 */
export async function generateFilesWithVision(
  text: string,
  systemPrompt: string,
  screenshots: ScreenshotImage[],
): Promise<ProjectFile[]> {
  const parts: PromptPart[] = buildPromptParts(
    text,
    screenshots.map((shot) => ({ dataUrl: shot.dataUrl })),
  );

  return generateStructuredFilesFromParts(parts, systemPrompt);
}

/** Joins the evidence directory with its screenshots subdirectory. */
export function screenshotsDirOf(evidenceDir: string): string {
  return join(evidenceDir, 'screenshots');
}
