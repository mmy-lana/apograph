/**
 * apograph — DOM snapshot capture (Layer 4: UI & Design System).
 *
 * Extracts the accessibility tree and design tokens from a live page,
 * producing the canonical `DOMSnapshot` record.
 *
 * Note: `page.accessibility.snapshot()` was removed in Playwright 1.64. The
 * equivalent structured tree is fetched via a CDP session using
 * `Accessibility.getFullAXTree`, which returns the same role/name/value/
 * description data and is rebuilt into a tree here.
 */

import type { Page } from 'playwright';
import * as csstree from 'css-tree';
import { validateNetworkUrl } from '../crawler/network-policy.js';
import type { A11yNode, CanvasBackgroundSource, CanvasTheme, DesignTokens, DOMSnapshot, FontFaceRule, TextSpan, TextStyle } from '../types.js';

// ---------------------------------------------------------------------------
// A11y tree extraction
// ---------------------------------------------------------------------------

/** Extracts a string field from a CDP AXValue without leaking `any`. */
function axValueToString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The subset of CDP AXNode data apograph consumes. */
interface CdpA11yNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  description?: { value?: unknown };
  parentId?: string;
  childIds?: string[];
}

/**
 * Snapshots the page's accessibility tree via CDP
 * (`Accessibility.getFullAXTree`) and maps it into the canonical `A11yNode`
 * structure. Returns a fallback WebArea root when the tree is unavailable.
 */
export async function extractA11yTree(page: Page): Promise<A11yNode> {
  const client = await page.context().newCDPSession(page);

  try {
    const { nodes } = (await client.send(
      'Accessibility.getFullAXTree',
    )) as { nodes: CdpA11yNode[] };

    const tree = buildA11yTree(nodes);
    if (tree) return tree;
    return { role: 'WebArea', name: 'Document', children: [] };
  } finally {
    await client.detach();
  }
}

/** Rebuilds a hierarchical tree from the flat CDP node list. */
function buildA11yTree(nodes: CdpA11yNode[]): A11yNode | null {
  const byId = new Map<string, CdpA11yNode>();
  for (const node of nodes) {
    byId.set(node.nodeId, node);
  }

  const root = nodes.find((node) => !node.parentId && !node.ignored);
  if (!root) return null;

  return mapA11yNode(root, byId, new Set<string>());
}

/** Recursively converts a CDP a11y node into the canonical shape. */
function mapA11yNode(
  node: CdpA11yNode,
  byId: Map<string, CdpA11yNode>,
  visited: Set<string>,
): A11yNode {
  const role = axValueToString(node.role?.value) ?? 'unknown';
  const mapped: A11yNode = { role, children: [] };

  const name = axValueToString(node.name?.value);
  if (name !== undefined) mapped.name = name;

  const value = axValueToString(node.value?.value);
  if (value !== undefined) mapped.value = value;

  const description = axValueToString(node.description?.value);
  if (description !== undefined) mapped.description = description;

  visited.add(node.nodeId);

  /**
   * Ignored AX nodes are often presentational/container nodes. They should
   * not become output nodes, but their descendants can still contain the
   * visible semantic tree. Flatten them instead of dropping the subtree.
   */
  const appendChild = (child: CdpA11yNode): void => {
    if (visited.has(child.nodeId)) return;
    if (child.ignored) {
      visited.add(child.nodeId);
      for (const descendantId of child.childIds ?? []) {
        const descendant = byId.get(descendantId);
        if (descendant !== undefined) appendChild(descendant);
      }
      return;
    }
    mapped.children?.push(mapA11yNode(child, byId, visited));
  };

  for (const childId of node.childIds ?? []) {
    const child = byId.get(childId);
    if (child !== undefined) appendChild(child);
  }

  return mapped;
}

// ---------------------------------------------------------------------------
// Canvas theme extraction (spec s4.1)
// ---------------------------------------------------------------------------

/**
 * In-page collector for the effective canvas colors of the document.
 *
 * Resolves the background through a generic chain: the computed `body`
 * background first (spec s4.1), then the root element's background, then the
 * painted-surface chain under the frame corner (full-bleed wrapper divs on
 * SPA shells). Pages that paint nothing (fully transparent canvas) report an
 * empty background so the crawler can ground the color in the rendered
 * pixels instead of silently defaulting to white.
 *
 * Serialized by `page.evaluate`: must stay fully self-contained (patch spec
 * s2.1).
 */
function collectBodyComputedStyle(): {
  backgroundColor: string;
  color: string;
  source: string;
} {
  /**
   * Canonicalizes any CSS color the browser can parse (rgb()/rgba(), hex,
   * hsl(), color(srgb ...), oklch()/oklab()/lab()) through the canvas
   * context's fillStyle serialization: '#rrggbb' for opaque sRGB colors,
   * 'rgba(r, g, b, a)' otherwise. Unparseable values pass through raw.
   */
  const canonical = (value: string): string => {
    try {
      const context = document.createElement('canvas').getContext('2d');
      if (context !== null) {
        context.fillStyle = '#010203';
        context.fillStyle = value;
        if (context.fillStyle !== '#010203') return context.fillStyle;
      }
    } catch {
      // Fall through to the raw value.
    }
    return value;
  };
  /** True for canonical colors that paint an opaque surface. */
  const opaque = (value: string): boolean => {
    const trimmed = value.trim();
    const rgba = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(
      trimmed,
    );
    if (rgba !== null) return rgba[4] === undefined || Number(rgba[4]) > 0;
    return /^#[0-9a-f]{3}$/.test(trimmed) || /^#[0-9a-f]{6}$/.test(trimmed);
  };

  const bodyStyle = getComputedStyle(document.body);
  const color = canonical(bodyStyle.color);
  const candidates: Array<{ value: string; source: string }> = [
    { value: canonical(bodyStyle.backgroundColor), source: 'body' },
    {
      value: canonical(getComputedStyle(document.documentElement).backgroundColor),
      source: 'root',
    },
  ];
  // Painted-surface chain: when body and root stay transparent, the surface
  // that paints under the frame corner is the effective canvas.
  let surface: Element | null = document.elementFromPoint(1, 1);
  while (surface !== null) {
    candidates.push({
      value: canonical(getComputedStyle(surface).backgroundColor),
      source: 'painted-element',
    });
    surface = surface.parentElement;
  }
  for (const candidate of candidates) {
    if (opaque(candidate.value)) {
      return { backgroundColor: candidate.value, color, source: candidate.source };
    }
  }
  // Fully transparent canvas: rendered-pixel grounding decides downstream.
  return { backgroundColor: '', color, source: 'rendered-pixels' };
}

/**
 * Normalizes a CSS color value (`rgb(...)`, `rgba(...)`, or `#rgb`/`#rrggbb`)
 * to lowercase `#rrggbb`. Returns null for transparent, non-opaque, or
 * unparseable values so callers can skip them.
 */
export function normalizeColorToHex(value: string): string | null {
  const trimmed = value.trim().toLowerCase();

  const rgbMatch = trimmed.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/,
  );
  if (rgbMatch !== null) {
    const alpha = rgbMatch[4] !== undefined ? Number(rgbMatch[4]) : 1;
    if (alpha === 0) return null;
    const r = rgbMatch[1] as string;
    const g = rgbMatch[2] as string;
    const b = rgbMatch[3] as string;
    const hex = (n: string): string => Number(n).toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }

  const hexMatch = trimmed.match(/^#([0-9a-f]{6})$/);
  if (hexMatch !== null) return `#${hexMatch[1] as string}`;

  const shortMatch = trimmed.match(/^#([0-9a-f]{3})$/);
  if (shortMatch !== null) {
    const chars = shortMatch[1]?.split('') ?? [];
    const a = chars[0];
    const b = chars[1];
    const c = chars[2];
    if (a === undefined || b === undefined || c === undefined) return null;
    return `#${a}${a}${b}${b}${c}${c}`;
  }

  return null;
}

/**
 * Extracts the effective canvas theme (spec s4.1): the computed body
 * background when it paints, otherwise the root/painted-surface fallback.
 * Returns undefined for a fully transparent canvas — the crawler then
 * grounds the color in the rendered pixels rather than defaulting to white.
 */
export async function extractCanvasTheme(page: Page): Promise<CanvasTheme | undefined> {
  const computed = await page.evaluate(collectBodyComputedStyle);
  const backgroundColor = normalizeColorToHex(computed.backgroundColor);
  if (backgroundColor === null) return undefined;

  const source: CanvasBackgroundSource =
    computed.source === 'root' ||
    computed.source === 'painted-element' ||
    computed.source === 'rendered-pixels'
      ? computed.source
      : 'body';
  const canvas: CanvasTheme = { backgroundColor, source };
  const color = normalizeColorToHex(computed.color);
  if (color !== null) canvas.color = color;
  return canvas;
}

// ---------------------------------------------------------------------------
// Design token extraction
// ---------------------------------------------------------------------------

/** Serializes all readable stylesheets of the active document into CSS text. */
function collectCssText(): string {
  const chunks: string[] = [];

  for (const style of Array.from(document.querySelectorAll('style'))) {
    chunks.push(style.textContent ?? '');
  }

  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = sheet.cssRules;
      for (const rule of Array.from(rules)) {
        chunks.push(rule.cssText);
      }
    } catch {
      // Cross-origin stylesheets throw on cssRules access; skip them.
    }
  }

  return chunks.join('\n');
}

/**
 * In-page collector: the hrefs of stylesheets whose rules are unreadable
 * from the page (cross-origin `cssRules` access throws). Those stylesheets
 * typically carry `@font-face` rules for CDN-hosted webfonts (Google Fonts
 * and friends), so the crawler fetches their text server-side and mines it
 * for webfont replay evidence. Serialized by `page.evaluate`: must stay
 * fully self-contained (patch spec s2.1).
 */
function collectUnreadableStylesheetHrefs(): string[] {
  const hrefs: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      void sheet.cssRules;
    } catch {
      const href = sheet.href;
      if (typeof href === 'string' && href.length > 0) hrefs.push(href);
    }
  }
  return hrefs;
}

/**
 * Merges webfont evidence extracted from additional stylesheet text into an
 * accumulating token set (deterministic first-wins dedupe, mirroring
 * `collectWebFonts`). Pure and exported for testing.
 */
export function mergeFontTokens(
  base: { fontFaces: FontFaceRule[]; fontVariables: Record<string, string> },
  extra: { fontFaces: FontFaceRule[]; fontVariables: Record<string, string> },
): void {
  const seen = new Set(
    base.fontFaces.map((face) => `${face.family}|${face.weight ?? ''}|${face.style ?? ''}|${face.src}`),
  );
  for (const face of extra.fontFaces) {
    const key = `${face.family}|${face.weight ?? ''}|${face.style ?? ''}|${face.src}`;
    if (seen.has(key)) continue;
    seen.add(key);
    base.fontFaces.push(face);
  }
  for (const [name, value] of Object.entries(extra.fontVariables)) {
    if (!(name in base.fontVariables)) base.fontVariables[name] = value;
  }
}

/** Optional injection points for {@link extractDesignTokens} (tests provide fakes). */
export interface DesignTokenOptions {
  /**
   * Fetcher for the text of stylesheets that were unreadable in-page
   * (cross-origin). Returns null on failure; callers bound count and size.
   * Defaults to {@link fetchStylesheetText} (SSRF-policy-checked, bounded).
   */
  fetchStylesheetText?: (url: string) => Promise<string | null>;
  /** Cap on remote stylesheets fetched per page (default 5). */
  maxRemoteStylesheets?: number;
}

/** Per-stylesheet fetch timeout for cross-origin webfont CSS text. */
const STYLESHEET_FETCH_TIMEOUT_MS = 10_000;

/** Max bytes read from one cross-origin stylesheet (webfont CSS is small). */
const MAX_STYLESHEET_BYTES = 512 * 1024;

/**
 * Bounded, SSRF-policy-checked fetcher for the text of cross-origin
 * stylesheets (unreadable via `cssRules`). Every request passes the same
 * public-web network policy as asset mirroring — evidence capture, never a
 * policy bypass. Returns null on any failure so mining degrades silently.
 */
export async function fetchStylesheetText(url: string): Promise<string | null> {
  let validated: URL;
  try {
    validated = await validateNetworkUrl(url);
  } catch {
    return null;
  }
  try {
    const response = await fetch(validated.href, {
      redirect: 'follow',
      signal: AbortSignal.timeout(STYLESHEET_FETCH_TIMEOUT_MS),
      headers: { accept: 'text/css,*/*;q=0.8' },
    });
    if (!response.ok) return null;
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_STYLESHEET_BYTES) return null;
    const text = await response.text();
    return text.length > MAX_STYLESHEET_BYTES ? text.slice(0, MAX_STYLESHEET_BYTES) : text;
  } catch {
    return null;
  }
}

/**
 * Evaluates the page's active stylesheets and parses them with CSSTree to
 * extract normalized, deduplicated design tokens. Cross-origin stylesheets
 * (whose `cssRules` are unreadable in-page) are fetched as text through the
 * injected fetcher and mined for `@font-face` / font custom properties so
 * CDN-hosted webfonts (e.g. Google Fonts) join the replay evidence.
 */
export async function extractDesignTokens(
  page: Page,
  options: DesignTokenOptions = {},
): Promise<DesignTokens> {
  const [css, canvas, remoteHrefs] = await Promise.all([
    page.evaluate(collectCssText),
    extractCanvasTheme(page),
    page.evaluate(collectUnreadableStylesheetHrefs),
  ]);

  const colors = new Map<string, string>();
  const fonts = new Set<string>();
  const spacing = new Set<string>();
  const radii = new Set<string>();

  const ast = csstree.parse(css, { parseValue: false, parseCustomProperty: true });

  csstree.walk(ast, (node) => {
    if (node.type !== 'Declaration') return;

    const property = csstree.property(node.property).name;
    const value = normalizeValue(csstree.generate(node.value));

    if (!value) return;

    switch (property) {
      case 'color':
      case 'background-color':
      case 'border-color': {
        if (isCleanColorValue(value)) colors.set(`${property}:${value}`, value);
        break;
      }
      case 'font-family': {
        if (isFontFamilyValue(value)) fonts.add(value);
        break;
      }
      case 'margin':
      case 'margin-top':
      case 'margin-right':
      case 'margin-bottom':
      case 'margin-left':
      case 'padding':
      case 'padding-top':
      case 'padding-right':
      case 'padding-bottom':
      case 'padding-left':
      case 'gap':
      case 'row-gap':
      case 'column-gap': {
        if (isSpacingValue(value)) spacing.add(value);
        break;
      }
      case 'border-radius': {
        radii.add(value);
        break;
      }
      default:
        break;
    }
  });

  // Mine cross-origin stylesheet text for @font-face rules and font custom
  // properties: CDN-hosted webfonts are the common case and must join the
  // replay evidence. Bounded and first-wins.
  const fontTokens = extractFontTokens(css);
  const fetchRemote = options.fetchStylesheetText ?? fetchStylesheetText;
  const limit = Math.max(0, options.maxRemoteStylesheets ?? 5);
  for (const href of [...new Set(remoteHrefs)].slice(0, limit)) {
    let text: string | null = null;
    try {
      text = await fetchRemote(href);
    } catch {
      text = null;
    }
    if (text === null || text.length === 0) continue;
    mergeFontTokens(fontTokens, extractFontTokens(text));
  }
  return {
    colors: Object.fromEntries(colors),
    fonts: [...fonts].sort(),
    spacing: [...spacing].sort(),
    radii: [...radii].sort(),
    ...(canvas !== undefined ? { canvas } : {}),
    ...(fontTokens.fontFaces.length > 0 ? { fontFaces: fontTokens.fontFaces } : {}),
    ...(Object.keys(fontTokens.fontVariables).length > 0
      ? { fontVariables: fontTokens.fontVariables }
      : {}),
  };
}

/**
 * Pure extractor for webfont replay evidence: every readable `@font-face`
 * rule (family/src/weight/style) plus font-related custom properties such
 * as `--font-sans` / `--font-mono` / `--default-font-family`. Cross-origin
 * stylesheets are unreadable by design (see `collectCssText`) and simply
 * contribute nothing here.
 */
export function extractFontTokens(css: string): {
  fontFaces: FontFaceRule[];
  fontVariables: Record<string, string>;
} {
  const ast = csstree.parse(css, { parseValue: false, parseCustomProperty: true });
  const faces = new Map<string, FontFaceRule>();
  const variables: Record<string, string> = {};

  csstree.walk(ast, {
    visit: 'Atrule',
    enter(node) {
      if (node.name !== 'font-face' || node.block === null) return;
      const descriptors: Record<string, string> = {};
      node.block.children.forEach((child) => {
        if (child.type !== 'Declaration') return;
        descriptors[csstree.property(child.property).name] = normalizeValue(csstree.generate(child.value));
      });
      const family = (descriptors['font-family'] ?? '').replace(/^['"]|['"]$/g, '');
      const src = descriptors['src'] ?? '';
      if (family.length === 0) return;
      const weight = descriptors['font-weight'];
      const style = descriptors['font-style'];
      const key = `${family}|${weight ?? ''}|${style ?? ''}|${src}`;
      if (!faces.has(key)) {
        faces.set(key, {
          family,
          src,
          ...(weight !== undefined ? { weight } : {}),
          ...(style !== undefined ? { style } : {}),
        });
      }
    },
  });

  csstree.walk(ast, (node) => {
    if (node.type !== 'Declaration') return;
    const property = csstree.property(node.property).name;
    if (!/^--(?:default-)?font/.test(property)) return;
    const value = normalizeValue(csstree.generate(node.value));
    if (value.length > 0 && value.length <= 500 && !(property in variables)) {
      variables[property] = value;
    }
  });

  return { fontFaces: [...faces.values()], fontVariables: variables };
}

/** Collapses generated CSS whitespace into a single-line token value. */
function normalizeValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** True when a token is a clean color value suitable for synthesis prompts. */
function isCleanColorValue(value: string): boolean {
  const normalized = value.toLowerCase();
  if (['color-mix', 'inherit', 'currentcolor', 'rgb(from'].some((token) => normalized.includes(token))) return false;
  return /^#[0-9a-f]{3,8}$/i.test(value) || /^(rgb|hsl)\(/i.test(value);
}

/** True when a token is a font family rather than a CSS length or variable. */
function isFontFamilyValue(value: string): boolean {
  return !/^\s*(?:\d+(?:\.\d+)?(?:px|pt|em|rem|%|vh|vw)|var\(--text-[^)]+\))\s*$/i.test(value);
}

/** True when a value looks like a length/percentage (not `auto`/`inherit`/etc). */
function isSpacingValue(value: string): boolean {
  return /^\d+(\.\d+)?(px|rem|em|%|vh|vw|ch|pt)$/.test(value);
}

// ---------------------------------------------------------------------------
// Visible text corpus extraction (spec s5.1)
// ---------------------------------------------------------------------------

/** Raw, per-text-node data gathered in-page before pure filtering. */
export interface RawTextSpan {
  text: string;
  color: string;
  backgroundImage: string;
  backgroundClip: string;
  webkitTextFillColor: string;
  display: string;
  visibility: string;
  boxTop: number;
  boxLeft: number;
  boxWidth: number;
  boxHeight: number;
  tag: string;
  parentTag: string;
  /** True when the text renders inside preformatted/code content. */
  preformatted?: boolean;
  /** Computed `font-size` (e.g. `30px`); optional on legacy fixtures. */
  fontSize?: string;
  /** Computed `font-weight` (e.g. `900`). */
  fontWeight?: string;
  /** Computed `line-height`. */
  lineHeight?: string;
  /** Computed `letter-spacing`. */
  letterSpacing?: string;
  /** Computed `text-transform`. */
  textTransform?: string;
  /** Computed `font-family` stack. */
  fontFamily?: string;
  /** Computed `text-align`. */
  textAlign?: string;
  /** `href` of the nearest ancestor anchor, as authored (optional). */
  href?: string;
}

/** True when a computed color is fully transparent (alpha 0). */
export function isTransparentColor(color: string): boolean {
  const trimmed = color.trim().toLowerCase();
  if (trimmed === 'transparent') return true;
  const match = trimmed.match(/^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (match === null) return false;
  const alpha = match[1] !== undefined ? Number(match[1]) : 1;
  return alpha === 0;
}

/** True when an element's computed styles mark it as a gradient text span. */
export function isGradientText(raw: {
  backgroundImage: string;
  backgroundClip: string;
  webkitTextFillColor: string;
}): boolean {
  const hasGradient = /gradient\(/i.test(raw.backgroundImage);
  const clipText = raw.backgroundClip.includes('text');
  const fillTransparent = isTransparentColor(raw.webkitTextFillColor);
  return hasGradient && (clipText || fillTransparent);
}

/**
 * Pure mapping of raw computed typography values to the canonical
 * `TextStyle` (spec s5.1): drops unresolvable/identity values (`normal`
 * line-height/letter-spacing, `none` text-transform, empty strings) and
 * reduces the font stack to its first family. Returns `undefined` when
 * nothing measurable remains.
 */
export function buildTextStyle(raw: RawTextSpan): TextStyle | undefined {
  const style: TextStyle = {};
  if (raw.fontSize !== undefined && raw.fontSize.trim().length > 0) {
    style.fontSize = raw.fontSize.trim();
  }
  if (raw.fontWeight !== undefined && raw.fontWeight.trim().length > 0) {
    style.fontWeight = raw.fontWeight.trim();
  }
  const lineHeight = raw.lineHeight?.trim();
  if (lineHeight !== undefined && lineHeight.length > 0 && lineHeight !== 'normal') {
    style.lineHeight = lineHeight;
  }
  const letterSpacing = raw.letterSpacing?.trim();
  if (letterSpacing !== undefined && letterSpacing.length > 0 && letterSpacing !== 'normal') {
    style.letterSpacing = letterSpacing;
  }
  const textTransform = raw.textTransform?.trim();
  if (textTransform !== undefined && textTransform.length > 0 && textTransform !== 'none') {
    style.textTransform = textTransform;
  }
  const family = raw.fontFamily?.split(',')[0]?.trim().replace(/^["']|["']$/g, '');
  if (family !== undefined && family.length > 0) {
    style.fontFamily = family;
  }
  const textAlign = raw.textAlign?.trim();
  if (textAlign !== undefined && textAlign.length > 0) {
    style.textAlign = textAlign;
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

/**
 * Pure mapping/filtering from raw in-page span data to the canonical
 * `TextSpan` corpus (spec s5.1): drops `display: none`, `visibility: hidden`,
 * zero-box, alpha-0-text, and empty-text entries; keeps document order; and
 * captures gradient definitions verbatim on gradient headline spans.
 */
export function buildTextSpans(raw: RawTextSpan[]): TextSpan[] {
  const spans: TextSpan[] = [];
  for (const entry of raw) {
    if (entry.display === 'none') continue;
    if (entry.visibility === 'hidden') continue;
    if (entry.boxWidth <= 0 || entry.boxHeight <= 0) continue;
    if (isTransparentColor(entry.color)) continue;
    const text = entry.text.trim();
    if (text.length === 0) continue;

    const span: TextSpan = {
      text,
      color: entry.color,
      tag: entry.tag,
      parentTag: entry.parentTag,
      boundingBox: {
        top: entry.boxTop,
        left: entry.boxLeft,
        width: entry.boxWidth,
        height: entry.boxHeight,
      },
    };
    if (isGradientText(entry)) span.gradient = entry.backgroundImage;
    const style = buildTextStyle(entry);
    if (style !== undefined) span.style = style;
    // Preformatted/code provenance: documented value tokens (`undefined`,
    // `${…}` interpolation) are genuine copy inside code content.
    if (entry.preformatted === true) span.preformatted = true;
    // Link target replay: only spans actually rendered inside an anchor carry
    // an href — synthesizers must never invent one for plain text.
    if (entry.href !== undefined && entry.href.length > 0) span.href = entry.href;
    spans.push(span);
  }
  return spans;
}

/**
 * In-page collector harvesting raw visible text-node data in document order.
 *
 * Patch spec s2.1 (integration/patch-capture-scrolling): this function is
 * serialized into Chromium's isolated browser V8 context by
 * `page.evaluate`, so it must be 100% lexically self-contained. The
 * semantic-ancestor lookup set and the ancestor-walking helper are declared
 * INSIDE this body; referencing any Node module-scope identifier would
 * throw `ReferenceError` in the browser at runtime.
 */
function collectRawTextSpans(): RawTextSpan[] {
  if (document.body === null) return [];
  const raw: RawTextSpan[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

  // Semantic ancestor tags used to resolve `parentTag` — internal to this
  // evaluated closure (patch spec s2.1 Rule 1).
  const SEMANTIC_ANCESTORS = new Set([
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'li', 'a', 'button', 'blockquote', 'figcaption', 'summary', 'label', 'dt', 'dd',
  ]);

  const semanticAncestor = (el: Element | null): string | null => {
    let current: Element | null = el;
    while (current !== null) {
      const tag = current.tagName.toLowerCase();
      if (SEMANTIC_ANCESTORS.has(tag)) return tag;
      current = current.parentElement;
    }
    return null;
  };

  // Nearest ancestor anchor's href, verbatim as authored (empty string when
  // the text is not inside a link) — internal to this evaluated closure
  // (patch spec s2.1 Rule 1).
  const anchorHref = (el: Element | null): string => {
    let current: Element | null = el;
    while (current !== null) {
      if (current.tagName.toLowerCase() === 'a') {
        const href = current.getAttribute('href');
        return href !== null ? href.trim() : '';
      }
      current = current.parentElement;
    }
    return '';
  };

  // Preformatted/code ancestor lookup (pre/code/kbd/samp/var/tt) — internal
  // to this evaluated closure (patch spec s2.1 Rule 1). Marks spans whose
  // text is documented code content rather than prose.
  const preformattedAncestor = (el: Element | null): boolean => {
    const CODE_TAGS = new Set(['pre', 'code', 'kbd', 'samp', 'var', 'tt']);
    let current: Element | null = el;
    while (current !== null) {
      if (CODE_TAGS.has(current.tagName.toLowerCase())) return true;
      current = current.parentElement;
    }
    return false;
  };

  while (walker.nextNode()) {
    const textNode = walker.currentNode as Text;
    const text = textNode.textContent ?? '';
    if (text.trim().length === 0) continue;

    const element = textNode.parentElement;
    if (element === null) continue;

    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
    const parentTag = semanticAncestor(element.parentElement) ?? element.parentElement?.tagName.toLowerCase() ?? tag;

    raw.push({
      text,
      color: style.color,
      backgroundImage: style.backgroundImage,
      backgroundClip: style.backgroundClip,
      webkitTextFillColor: style.webkitTextFillColor,
      display: style.display,
      visibility: style.visibility,
      boxTop: rect.top,
      boxLeft: rect.left,
      boxWidth: rect.width,
      boxHeight: rect.height,
      tag,
      parentTag,
      preformatted: preformattedAncestor(element),
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      textTransform: style.textTransform,
      fontFamily: style.fontFamily,
      textAlign: style.textAlign,
      href: anchorHref(element),
    });
  }
  return raw;
}

/** Extracts the visible text corpus for the current page (spec s5.1). */
export async function extractTextSpans(page: Page): Promise<TextSpan[]> {
  const raw = await page.evaluate(collectRawTextSpans);
  return buildTextSpans(raw);
}

// ---------------------------------------------------------------------------
// Snapshot orchestration
// ---------------------------------------------------------------------------

/**
 * Captures a full DOM snapshot for a route: the accessibility tree, the
 * extracted design tokens, and the visible text corpus (spec s5.1), all
 * gathered concurrently.
 */
export async function captureDOMSnapshot(
  page: Page,
  route: string,
  tokenOptions: DesignTokenOptions = {},
): Promise<DOMSnapshot> {
  const [a11yTree, tokens, textSpans] = await Promise.all([
    extractA11yTree(page),
    extractDesignTokens(page, tokenOptions),
    extractTextSpans(page),
  ]);

  return { route, a11yTree, tokens, textSpans };
}
