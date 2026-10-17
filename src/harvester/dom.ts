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
import type { A11yNode, CanvasTheme, DesignTokens, DOMSnapshot, TextSpan } from '../types.js';

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

/** In-page collector for the computed colors of `document.body`. */
function collectBodyComputedStyle(): { backgroundColor: string; color: string } {
  const style = getComputedStyle(document.body);
  return {
    backgroundColor: style.backgroundColor,
    color: style.color,
  };
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

/** Extracts the computed `document.body` canvas theme (spec s4.1). */
export async function extractCanvasTheme(page: Page): Promise<CanvasTheme | undefined> {
  const computed = await page.evaluate(collectBodyComputedStyle);
  const backgroundColor = normalizeColorToHex(computed.backgroundColor);
  if (backgroundColor === null) return undefined;

  const canvas: CanvasTheme = { backgroundColor };
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
 * Evaluates the page's active stylesheets and parses them with CSSTree to
 * extract normalized, deduplicated design tokens.
 */
export async function extractDesignTokens(page: Page): Promise<DesignTokens> {
  const [css, canvas] = await Promise.all([
    page.evaluate(collectCssText),
    extractCanvasTheme(page),
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
        colors.set(`${property}:${value}`, value);
        break;
      }
      case 'font-family':
      case 'font-size': {
        fonts.add(value);
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

  return {
    colors: Object.fromEntries(colors),
    fonts: [...fonts].sort(),
    spacing: [...spacing].sort(),
    radii: [...radii].sort(),
    ...(canvas !== undefined ? { canvas } : {}),
  };
}

/** Collapses generated CSS whitespace into a single-line token value. */
function normalizeValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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
export async function captureDOMSnapshot(page: Page, route: string): Promise<DOMSnapshot> {
  const [a11yTree, tokens, textSpans] = await Promise.all([
    extractA11yTree(page),
    extractDesignTokens(page),
    extractTextSpans(page),
  ]);

  return { route, a11yTree, tokens, textSpans };
}
