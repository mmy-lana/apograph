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
import type { A11yNode, DesignTokens, DOMSnapshot } from '../types.js';

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

  for (const childId of node.childIds ?? []) {
    if (visited.has(childId)) continue;
    const child = byId.get(childId);
    if (!child || child.ignored) continue;
    mapped.children?.push(mapA11yNode(child, byId, visited));
  }

  return mapped;
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
  const css = await page.evaluate(collectCssText);

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
// Snapshot orchestration
// ---------------------------------------------------------------------------

/**
 * Captures a full DOM snapshot for a route: the accessibility tree and the
 * extracted design tokens, gathered concurrently.
 */
export async function captureDOMSnapshot(page: Page, route: string): Promise<DOMSnapshot> {
  const [a11yTree, tokens] = await Promise.all([
    extractA11yTree(page),
    extractDesignTokens(page),
  ]);

  return { route, a11yTree, tokens };
}
