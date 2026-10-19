/**
 * apograph — captured-evidence palette snap (deterministic synthesis output
 * normalization, remediation record #10).
 *
 * Vision synthesis approximates hues: it emits color literals that are close
 * to, but not exactly, the colors the source site renders. This module pins
 * emitted color literals to the run's own captured evidence palette: any
 * literal whose RGB is a tight approximation of a captured color (distance in
 * (0, MAX_COLOR_SNAP_DISTANCE]) is rewritten to the exact captured value.
 *
 * This is a generic, target-agnostic capability: the palette is built entirely
 * from the run's evidence manifest (design tokens, canvas colors, measured
 * text-span colors) for whichever site is being cloned. Literals that are
 * exact already, or that are genuinely distinct hues, are left untouched.
 * Rewrites change only the color channels — alpha values and separator
 * spacing are preserved byte-for-byte so Tailwind arbitrary values
 * (`bg-[rgba(0,243,255,.3)]` — spaces are forbidden inside arbitrary values)
 * keep compiling.
 */

import type { CrawlRoute, ProjectFile } from '../types.js';

/** An opaque sRGB color (0–255 per channel). */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** A parsed CSS color literal with its rewrite-safe textual parts. */
export interface ParsedColorLiteral {
  /** Resolved sRGB channels (alpha excluded). */
  rgb: RgbColor;
  /** Literal family: hex (`#…`) or functional (`rgb(`/`rgba(`). */
  family: 'hex' | 'func';
  /** Verbatim alpha as written: two-digit hex suffix, or `, .3` / `/ 50%`. */
  alphaText?: string;
}

/**
 * Maximum RGB Euclidean distance for a literal to be considered an
 * approximation of a captured color. Validated against measured drift: all
 * observed approximation pairs fall within 16 (e.g. `#00f3ff`→`#00f0ff` d=3),
 * while genuinely distinct hues sit well beyond it (e.g. `#145dff` vs
 * `#2563eb` d=26.9).
 */
export const MAX_COLOR_SNAP_DISTANCE = 16;

const HEX_SCAN = /#([0-9a-fA-F]{3,8})\b/g;
const FUNC_SCAN = /(rgba?\()(\s*)([0-9.]+%?)(\s*,\s*)([0-9.]+%?)(\s*,\s*)([0-9.]+%?)(\s*[,/]\s*[^)]*?)?(\s*\))/g;
const FUNC_PARSE = /^(rgba?\()(\s*)([0-9.]+%?)(\s*,\s*)([0-9.]+%?)(\s*,\s*)([0-9.]+%?)(\s*[,/]\s*[^)]*?)?(\s*\))$/;
const HEX_PARSE = /^#([0-9a-fA-F]{3,8})$/;

function channelToByte(raw: string): number | undefined {
  if (raw.endsWith('%')) {
    const percent = Number.parseFloat(raw);
    if (!Number.isFinite(percent)) return undefined;
    return Math.min(255, Math.max(0, Math.round((percent / 100) * 255)));
  }
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return undefined;
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** True when a verbatim alpha group is a plain value (`, .3` / `/ 50%`). */
function isSimpleAlpha(alphaGroup: string): boolean {
  return /^\s*[,/]\s*[0-9.]+%?$/.test(alphaGroup);
}

/**
 * Parses one CSS color literal (`#rgb/#rgba/#rrggbb/#rrggbbaa`,
 * `rgb()/rgba()` with `,` or `/` alpha separators) into channels plus the
 * verbatim alpha text needed to rewrite it safely. Returns `undefined` for
 * anything else (named colors, `hsl()`, `color-mix()`, `rgb(from …)`,
 * space-separated modern syntax).
 */
export function parseCssColor(value: string): ParsedColorLiteral | undefined {
  const trimmed = value.trim();
  const hex = HEX_PARSE.exec(trimmed);
  if (hex !== null) {
    const body = hex[1] ?? '';
    if (body.length !== 3 && body.length !== 4 && body.length !== 6 && body.length !== 8) {
      return undefined;
    }
    // Expand shorthand so the alpha suffix is always two digits.
    const full = body.length <= 4 ? [...body].map((c) => c + c).join('') : body;
    const rgb: RgbColor = {
      r: Number.parseInt(full.slice(0, 2), 16),
      g: Number.parseInt(full.slice(2, 4), 16),
      b: Number.parseInt(full.slice(4, 6), 16),
    };
    const alphaText = full.length === 8 ? full.slice(6, 8) : undefined;
    return { rgb, family: 'hex', alphaText };
  }
  const func = FUNC_PARSE.exec(trimmed);
  if (func !== null) {
    const r = channelToByte(func[3] ?? '');
    const g = channelToByte(func[5] ?? '');
    const b = channelToByte(func[7] ?? '');
    if (r === undefined || g === undefined || b === undefined) return undefined;
    const alphaGroup = func[8];
    const alphaText = alphaGroup !== undefined && isSimpleAlpha(alphaGroup)
      ? alphaGroup
      : undefined;
    return { rgb: { r, g, b }, family: 'func', alphaText };
  }
  return undefined;
}

/** Formats channels as lowercase `rrggbb`. */
export function rgbToHex(color: RgbColor): string {
  const part = (n: number) => Math.min(255, Math.max(0, Math.round(n))).toString(16).padStart(2, '0');
  return `${part(color.r)}${part(color.g)}${part(color.b)}`;
}

/** RGB Euclidean distance between two opaque colors. */
export function colorDistance(a: RgbColor, b: RgbColor): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

/**
 * Builds the deduped captured-color palette for a run from its evidence:
 * design-token colors, canvas colors, and measured text-span colors.
 */
export function buildEvidencePalette(routes: CrawlRoute[]): RgbColor[] {
  const seen = new Map<string, RgbColor>();
  const add = (value: string | undefined): void => {
    if (value === undefined || value.length === 0) return;
    const parsed = parseCssColor(value);
    if (parsed === undefined) return;
    const key = rgbToHex(parsed.rgb);
    if (!seen.has(key)) seen.set(key, parsed.rgb);
  };
  for (const route of routes) {
    const tokens = route.tokens;
    if (tokens !== undefined) {
      for (const value of Object.values(tokens.colors)) add(value);
      add(tokens.canvas?.backgroundColor);
      add(tokens.canvas?.color);
    }
    for (const span of route.textSpans ?? []) add(span.color);
    for (const span of route.mobileTextSpans ?? []) add(span.color);
  }
  return [...seen.values()];
}

/**
 * Finds the nearest captured color within the snap bound. Returns `undefined`
 * when the literal is exact (no rewrite needed) or genuinely distinct.
 */
export function findSnapTarget(
  rgb: RgbColor,
  palette: readonly RgbColor[],
): { color: RgbColor; distance: number } | undefined {
  let best: RgbColor | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of palette) {
    const distance = colorDistance(rgb, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  if (best === undefined) return undefined;
  if (bestDistance === 0 || bestDistance > MAX_COLOR_SNAP_DISTANCE) return undefined;
  return { color: best, distance: bestDistance };
}

/**
 * Rewrites one color literal to a captured palette color. Only the channel
 * text changes: the literal's family, alpha value as written, and separator
 * spacing are preserved. Returns `undefined` when no snap applies.
 */
export function snapColorLiteral(
  literal: string,
  palette: readonly RgbColor[],
): string | undefined {
  const parsed = parseCssColor(literal);
  if (parsed === undefined) return undefined;
  const target = findSnapTarget(parsed.rgb, palette);
  if (target === undefined) return undefined;
  const hex = rgbToHex(target.color);
  if (parsed.family === 'hex') {
    return parsed.alphaText !== undefined ? `#${hex}${parsed.alphaText}` : `#${hex}`;
  }
  const parts = FUNC_PARSE.exec(literal.trim());
  if (parts === null) return undefined;
  const head = parts[1] ?? 'rgb(';
  const ws1 = parts[2] ?? '';
  const sep1 = parts[4] ?? ', ';
  const sep2 = parts[6] ?? ', ';
  const tail = parts[9] ?? ')';
  return `${head}${ws1}${target.color.r}${sep1}${target.color.g}${sep2}${target.color.b}${parsed.alphaText ?? ''}${tail}`;
}

/**
 * Snaps every color literal in one source text. Only the channel numbers are
 * rewritten in functional literals (via `snapColorLiteral`), so arbitrary
 * Tailwind values keep their spacing. Returns the rewritten text and the
 * number of replacements.
 */
export function snapColorsInSource(
  source: string,
  palette: readonly RgbColor[],
): { content: string; replacements: number } {
  let replacements = 0;
  const snap = (match: string): string => {
    const snapped = snapColorLiteral(match, palette);
    if (snapped === undefined) return match;
    replacements += 1;
    return snapped;
  };
  const content = source.replace(HEX_SCAN, snap).replace(FUNC_SCAN, snap);
  return { content, replacements };
}

/** File extensions whose color literals participate in snapping. */
const SNAP_FILE_PATTERN = /\.(tsx|ts|css|html)$/;

/**
 * Snaps color literals across a generated project's source files (skipping
 * non-source files such as JSON manifests). Returns rewritten files and the
 * total replacement count.
 */
export function snapProjectColors(
  files: ProjectFile[],
  palette: readonly RgbColor[],
): { files: ProjectFile[]; replacements: number } {
  let replacements = 0;
  const snapped = files.map((file) => {
    if (!SNAP_FILE_PATTERN.test(file.path)) return file;
    const result = snapColorsInSource(file.content, palette);
    replacements += result.replacements;
    return result.replacements > 0 ? { ...file, content: result.content } : file;
  });
  return { files: snapped, replacements };
}
