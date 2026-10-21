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

/**
 * Loads the captured modal/overlay-state screenshots for a route (each
 * `ModalCapture`'s desktop + mobile PNGs) so synthesis can reproduce the
 * overlay's layout instead of guessing it. Missing files are silently
 * skipped. Pure loading — ordering/prompting is the caller's concern.
 */
export async function loadModalCaptureScreenshots(
  route: CrawlRoute,
  evidenceDir: string,
): Promise<ScreenshotImage[]> {
  const images: ScreenshotImage[] = [];
  for (const capture of route.modalCaptures ?? []) {
    if (capture.desktopScreenshot !== null) {
      const desktop = await loadScreenshotDataUrl(
        resolveScreenshotPath(capture.desktopScreenshot, evidenceDir),
        'desktop',
      );
      if (desktop) images.push(desktop);
    }
    if (capture.mobileScreenshot !== null) {
      const mobile = await loadScreenshotDataUrl(
        resolveScreenshotPath(capture.mobileScreenshot, evidenceDir),
        'mobile',
      );
      if (mobile) images.push(mobile);
    }
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
  const allValues = Object.values(tokens.colors).filter((value) => {
    const normalized = value.toLowerCase();
    if (['color-mix', 'inherit', 'currentcolor', 'rgb(from'].some((token) => normalized.includes(token))) return false;
    return /^#[0-9a-f]{3,8}$/i.test(value) || /^(rgb|hsl)\(/i.test(value);
  });
  const uniqueColors = [...new Set(allValues)].slice(0, MAX_PROMPT_COLORS);
  const totalUnique = new Set(allValues).size;
  const colors = uniqueColors.map((value) => `  ${value}`).join('\n');
  const paletteNote =
    totalUnique > MAX_PROMPT_COLORS
      ? `\n  ... (${totalUnique - MAX_PROMPT_COLORS} more colors omitted; pick hues from the screenshots)`
      : '';

  const canvas = tokens.canvas?.backgroundColor;
  const fonts = tokens.fonts.filter((font) =>
    !/^\s*(?:\d+(?:\.\d+)?(?:px|pt|em|rem|%|vh|vw)|var\(--text-[^)]+\))\s*$/i.test(font),
  );

  return [
    `Canvas background: ${canvas ?? 'not captured'}`,
    `Reduced palette (max ${MAX_PROMPT_COLORS} colors):\n${colors}${paletteNote}`,
    `Fonts: ${fonts.length > 0 ? fonts.slice(0, MAX_PROMPT_COLORS).join(', ') : '(none)'}`,
    `Spacing: ${tokens.spacing.length > 0 ? tokens.spacing.slice(0, MAX_PROMPT_COLORS).join(', ') : '(none)'}`,
    `Radii: ${tokens.radii.length > 0 ? tokens.radii.slice(0, MAX_PROMPT_COLORS).join(', ') : '(none)'}`,
  ].join('\n');
}

/** Serializes the mirrored-asset map for prompt embedding. */
export function formatAssetMapForPrompt(
  assets: Array<{
    originalUrl: string;
    localPath: string | null;
    status: string;
    canvasOverlay?: { opacity: number; position: string; coversViewport: boolean };
  }>,
): string {
  const downloaded = assets.filter(
    (asset) => asset.status === 'downloaded' && asset.localPath !== null,
  );
  if (downloaded.length === 0) return '(no mirrored assets)';

  return downloaded
    .map((asset) => {
      const filename = asset.localPath?.split('/').pop() ?? '';
      const overlay = asset.canvasOverlay;
      const overlayNote =
        overlay !== undefined && overlay.coversViewport
          ? `  [viewport overlay — ${overlay.position} full-viewport layer at opacity ${overlay.opacity}]`
          : '';
      return `  /assets/${filename}  <-  ${asset.originalUrl}${overlayNote}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Text corpus prompt formatting (spec s5.2)
// ---------------------------------------------------------------------------

/** Maximum text spans embedded in a single prompt (guards context size). */
export const MAX_PROMPT_TEXT_SPANS = 200;

/**
 * Formats one span's measured rendered geometry (computed typography plus
 * bounding box) as a compact metric string, or an empty string when nothing
 * was measured. Pure and exported for testing.
 */
export function formatMeasuredMetrics(span: TextSpan): string {
  const parts: string[] = [];
  const style = span.style;
  if (style?.fontSize !== undefined) parts.push(`fs ${style.fontSize}`);
  if (style?.fontWeight !== undefined) parts.push(`fw ${style.fontWeight}`);
  if (style?.lineHeight !== undefined) parts.push(`lh ${style.lineHeight}`);
  if (style?.letterSpacing !== undefined) parts.push(`ls ${style.letterSpacing}`);
  if (style?.textTransform !== undefined) parts.push(`transform ${style.textTransform}`);
  if (style?.fontFamily !== undefined) parts.push(`family ${style.fontFamily}`);
  if (style?.textAlign !== undefined && style.textAlign !== 'left' && style.textAlign !== 'start') {
    parts.push(`align ${style.textAlign}`);
  }
  const box = span.boundingBox;
  if (box !== undefined) {
    parts.push(
      `box ${Math.round(box.width)}x${Math.round(box.height)} @${Math.round(box.left)},${Math.round(box.top)}`,
    );
  }
  return parts.join(', ');
}

/**
 * Formats the harvested text corpus for prompt embedding (spec s5.2):
 * spans are sorted by vertical visual position (boundingBox.top ASC) so they
 * match the natural top-to-bottom reading order of the screenshot, falling
 * back to original document index when coordinates are absent or identical.
 *
 * Each span line carries its MEASURED rendered geometry (computed typography
 * and bounding box) captured from the live site. When `mobileSpans` is
 * provided (dual-viewport crawl, matched by exact span text), the mobile
 * viewport's measurements appear alongside the desktop ones so the model can
 * reproduce each viewport's type scale and wrapping widths instead of
 * guessing them from pixels.
 */
export function formatTextSpansForPrompt(spans: TextSpan[], mobileSpans?: TextSpan[]): string {
  if (spans.length === 0) return 'Text corpus: (not captured)';

  const mobileByText = new Map<string, TextSpan>();
  for (const span of mobileSpans ?? []) {
    if (!mobileByText.has(span.text)) mobileByText.set(span.text, span);
  }

  const ranked = spans
    .map((span, index) => ({ span, index }))
    .sort((a, b) => {
      const topA = a.span.boundingBox?.top ?? 0;
      const topB = b.span.boundingBox?.top ?? 0;
      return topA - topB || a.index - b.index;
    })
    .slice(0, MAX_PROMPT_TEXT_SPANS);

  let anyMetrics = false;
  const lines = ranked.map(({ span }) => {
    const tag = span.parentTag !== span.tag ? `${span.parentTag}>${span.tag}` : span.tag;
    const gradient = span.gradient !== undefined ? ` [gradient: ${span.gradient}]` : '';
    // Link-target replay: spans captured inside an anchor carry their exact
    // href; spans without one are plain text and must never gain an invented
    // <a href> in the output.
    const link = span.href !== undefined && span.href.length > 0 ? ` [link: ${span.href}]` : '';
    const measured = formatMeasuredMetrics(span);
    const mobile = mobileByText.get(span.text);
    const mobileMeasured =
      mobile !== undefined && mobile !== span ? formatMeasuredMetrics(mobile) : '';
    const primaryLabel = mobileMeasured.length > 0 ? 'desktop' : 'measured';
    const metrics =
      measured.length > 0 ? ` [${primaryLabel}: ${measured}]` : '';
    const mobileMetrics =
      mobileMeasured.length > 0 && mobileMeasured !== measured
        ? ` [mobile: ${mobileMeasured}]`
        : '';
    if (metrics.length > 0 || mobileMetrics.length > 0) anyMetrics = true;
    return `  [${tag}] ${span.text}${link}${gradient}${metrics}${mobileMetrics}`;
  });

  const truncated =
    ranked.length < spans.length ? `\n  ... (${spans.length - ranked.length} more spans omitted)` : '';

  const measuredNote = anyMetrics
    ? [
        'Bracketed metrics are MEASURED computed values captured from the live',
        'site (not estimates): fs = font-size, fw = font-weight, lh = line-height,',
        'ls = letter-spacing, family = computed font-family (first family in the',
        'stack), box WxH @x,y = element box (CSS px, left,top).',
        'Reproduce the measured type sizes, weights, wrapping widths, and',
        'vertical positions exactly (arbitrary Tailwind values such as',
        'text-[30px] font-[900] leading-[36px] w-[314px] are expected), and',
        "apply each span's measured family with an arbitrary font-family",
        "utility (e.g. font-[family-name:'Plus_Jakarta_Sans']) so text renders",
        'in the captured family instead of a generic fallback.',
      ]
    : [];

  return [
    'Text corpus (visible DOM text ordered top-to-bottom). Use this text to',
    'populate headings and copy accurately matching each section\'s visual hierarchy.',
    'Spans marked [link: <href>] were captured inside anchors — reuse that exact',
    'href on the corresponding <a>; spans without a [link:] marker are plain',
    'text (or buttons) and must NEVER be wrapped in an invented <a href>.',
    'Gradient headline spans MUST keep their exact gradient definition:',
    ...measuredNote,
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
/**
 * Reduces a component path to its schema-safe project-relative form for the
 * repair prompt and file matching. Callers may pass an absolute path (the
 * visual repair loop resolves components on disk first), but the structured
 * file contract only accepts safe relative paths — an absolute path echoed
 * back by the model would fail schema validation and silently abort the
 * repair turn. `src/…` paths are kept as-is; absolute paths are reduced to
 * their project-relative tail.
 */
export function toPromptComponentPath(componentPath: string): string {
  const normalized = componentPath.replaceAll('\\', '/').trim();
  const absoluteLike = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
  const schemaSafe =
    normalized.length > 0 && !absoluteLike && !/(?:^|\/)\.\.(?:\/|$)/.test(normalized);
  if (schemaSafe) return normalized;
  const srcIndex = normalized.lastIndexOf('/src/');
  if (srcIndex !== -1) return normalized.slice(srcIndex + 1);
  const segments = normalized.split('/').filter((part) => part.length > 0 && part !== '..');
  return segments.slice(-2).join('/');
}

/**
 * Selects the repaired file from a model response: exact project-relative
 * path first, then the caller's original path, then a normalized match, then
 * the first emitted file.
 */
export function selectRepairedFile<T extends { path: string; content: string }>(
  files: T[],
  componentPath: string,
  promptPath: string,
): T | undefined {
  return (
    files.find((file) => file.path === promptPath) ??
    files.find((file) => file.path === componentPath) ??
    files.find((file) => toPromptComponentPath(file.path) === promptPath) ??
    files[0]
  );
}

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
    'weights, text casing (text-transform), line wrapping, container',
    'alignment, responsive stacking and breakpoint',
    'behavior, and visibility. Do NOT rewrite unrelated',
    'code, do NOT restructure the component, do NOT change imports, props,',
    'state logic, or event handlers, and do NOT truncate the file.',
    '',
    'The diff overlay highlights every region that differs. A candidate that',
    'leaves the rendering unchanged cannot pass verification: make substantive',
    'corrections in the highlighted regions (casing, type scale, wrapping,',
    'spacing, and element sizing all count), not cosmetic one-line tweaks.',
    '',
    `Emit exactly one file — ${componentPath} — with the complete,`,
    'compile-ready corrected content, as one markdown file section:',
    `### File: ${componentPath}`,
    '```',
    '<complete corrected file content>',
    '```',
  ].join('\n');

  const systemPrompt = [
    'You are a surgical frontend repair agent. You receive one React',
    'component and a pixelmatch diff overlay against the reference site.',
    'Apply the minimum targeted styling corrections indicated by the diff.',
    'Respond with the corrected file as a single `### File: <path>` markdown',
    'section wrapping the complete corrected content in a fenced code block,',
    'no commentary and no truncation. Preserve everything the diff does not',
    'implicate.',
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
  // Prompt and match against the schema-safe project-relative form so the
  // model can echo a path the structured file contract accepts.
  const promptPath = toPromptComponentPath(componentPath);
  const { text, systemPrompt } = buildVisualRepairPrompt(promptPath, mismatchPercent);

  const parts: PromptPart[] = buildPromptParts(
    `${text}\n\nCurrent content of ${promptPath}:\n${currentCode}`,
    [
      { dataUrl: originalScreenshotDataUrl },
      { dataUrl: diffImageDataUrl },
    ],
  );

  const files = await generateStructuredFilesFromParts(parts, systemPrompt, {
    // Single-file repair: a raw (unfenced) corrected reply is accepted as
    // this file instead of failing extraction.
    defaultFilePath: promptPath,
  });
  const repaired = selectRepairedFile(files, componentPath, promptPath);
  if (repaired === undefined || repaired.content.trim().length === 0) {
    throw new Error(`Visual repair for ${promptPath} returned no file content.`);
  }
  return repaired.content;
}
