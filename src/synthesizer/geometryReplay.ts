/**
 * apograph — measured rendered-geometry replay (generated-project capability).
 *
 * Synthesizes a standalone `src/geometry-replay.ts` module for an emitted
 * project from the evidence manifest's per-viewport measured text geometry
 * (remediation record #7): computed typography metrics and bounding boxes
 * captured from the live site are enforced at runtime on the generated DOM,
 * so type scale, line wrapping, and single-line rendering reproduce the
 * measured ground truth instead of depending on prompt estimation.
 *
 * This module is a generic, target-agnostic capability: every value it emits
 * comes from the run's own captured evidence for whichever site is being
 * cloned. Sites without measured spans produce no module at all. The emitted
 * file is annotation-free TypeScript (valid plain JS) so it compiles under the
 * scaffold's TypeScript settings and stays importable in tests.
 */

import type { CrawlRoute, ProjectFile, TextSpan } from '../types.js';

/** One measured-geometry rule emitted into the generated replay module. */
export interface MeasuredRule {
  /** Trimmed DOM text of the measured span (verbatim corpus text). */
  text: string;
  /** Computed typography that must be enforced (subset, measured only). */
  style: {
    fs?: string;
    fw?: string;
    lh?: string;
    ls?: string;
    tt?: string;
    align?: string;
  };
  /** Measured wrap width for multi-line spans (CSS px). */
  width?: number;
  /** True when the span renders on a single line at this viewport. */
  nowrap?: boolean;
  /** Measured absolute top of the span's box (CSS px from the document top). */
  top?: number;
  /** Measured absolute left of the span's box (CSS px from the document left). */
  left?: number;
  /** Measured box width (CSS px) — guards position snaps to same-surface boxes. */
  boxWidth?: number;
}

/** Per-route rule groups keyed by viewport: `d` = desktop, `m` = mobile. */
export interface RouteRuleGroup {
  d: MeasuredRule[];
  m: MeasuredRule[];
}

/** Maximum rules embedded per viewport group (guards generated size). */
export const MAX_REPLAY_RULES = 300;

/**
 * Estimates the rendered line height of a span in CSS px from its measured
 * style (line-height when resolvable, else 1.2 × font-size, else 0).
 */
function lineEstimatePx(span: TextSpan): number {
  const lh = span.style?.lineHeight;
  if (lh !== undefined && lh.endsWith('px')) {
    const value = Number.parseFloat(lh);
    if (Number.isFinite(value)) return value;
  }
  const fs = span.style?.fontSize;
  if (fs !== undefined && fs.endsWith('px')) {
    const value = Number.parseFloat(fs);
    if (Number.isFinite(value)) return value * 1.2;
  }
  return 0;
}

/**
 * Pure mapping from one measured span to a replay rule, or `undefined` when
 * the span carries no measurable typography or geometry.
 */
export function buildMeasuredRule(span: TextSpan): MeasuredRule | undefined {
  const style = span.style;
  const box = span.boundingBox;
  const ruleStyle: MeasuredRule['style'] = {};
  if (style?.fontSize !== undefined) ruleStyle.fs = style.fontSize;
  if (style?.fontWeight !== undefined) ruleStyle.fw = style.fontWeight;
  if (style?.lineHeight !== undefined) ruleStyle.lh = style.lineHeight;
  if (style?.letterSpacing !== undefined) ruleStyle.ls = style.letterSpacing;
  // text-transform is pinned whenever typography was measured: a measured
  // identity (`none`) forbids invented casing transforms just as a measured
  // `uppercase` demands one. Legacy spans without any measured style leave
  // text-transform untouched.
  if (style !== undefined) ruleStyle.tt = style.textTransform ?? 'none';
  if (
    style?.textAlign !== undefined &&
    style.textAlign !== 'left' &&
    style.textAlign !== 'start'
  ) {
    ruleStyle.align = style.textAlign;
  }

  const rule: MeasuredRule = { text: span.text.trim(), style: ruleStyle };
  if (box !== undefined) {
    const lineEstimate = lineEstimatePx(span);
    const singleLine = lineEstimate > 0 && box.height <= lineEstimate * 1.25;
    if (singleLine) {
      rule.nowrap = true;
    } else {
      rule.width = Math.round(box.width * 10) / 10;
    }
    rule.top = Math.round(box.top * 10) / 10;
    rule.left = Math.round(box.left * 10) / 10;
    rule.boxWidth = Math.round(box.width * 10) / 10;
  }
  if (Object.keys(ruleStyle).length === 0 && box === undefined) {
    return undefined;
  }
  return rule;
}

/**
 * Builds per-route desktop/mobile rule groups from the manifest's measured
 * corpora. `textSpans` are attributed to the viewport the route snapshot was
 * measured at (desktop when a desktop screenshot was captured, else mobile);
 * `mobileTextSpans` always belong to the mobile viewport.
 */
export function buildReplayGroups(routes: CrawlRoute[]): Record<string, RouteRuleGroup> {
  const groups: Record<string, RouteRuleGroup> = {};
  for (const route of routes) {
    const desktopMeasured = route.desktopScreenshot !== null;
    const group: RouteRuleGroup = { d: [], m: [] };
    for (const span of route.textSpans ?? []) {
      const rule = buildMeasuredRule(span);
      if (rule === undefined) continue;
      (desktopMeasured ? group.d : group.m).push(rule);
    }
    for (const span of route.mobileTextSpans ?? []) {
      const rule = buildMeasuredRule(span);
      if (rule === undefined) continue;
      group.m.push(rule);
    }
    group.d = group.d.slice(0, MAX_REPLAY_RULES);
    group.m = group.m.slice(0, MAX_REPLAY_RULES);
    if (group.d.length > 0 || group.m.length > 0) {
      groups[route.path] = group;
    }
  }
  return groups;
}

/**
 * Pure rule matching used by the generated runtime (and mirrored by its
 * tests): exact DOM-text match wins, then case-folded equality, then the
 * longest contained rule (minimum 4 chars). Claimed rules are skipped so
 * duplicate corpus texts match successive elements in document order.
 */
export function selectMeasuredRule(
  rules: MeasuredRule[],
  elementText: string,
  claimed: ReadonlySet<MeasuredRule>,
): MeasuredRule | undefined {
  const trimmed = elementText.trim();
  const folded = trimmed.toUpperCase();
  let foldedEqual: MeasuredRule | undefined;
  let contained: MeasuredRule | undefined;
  for (const rule of rules) {
    if (claimed.has(rule)) continue;
    const text = rule.text.trim();
    if (text.length === 0) continue;
    if (text === trimmed) return rule;
    const ruleFolded = text.toUpperCase();
    if (ruleFolded === folded) {
      if (foldedEqual === undefined) foldedEqual = rule;
      continue;
    }
    if (text.length >= 4 && folded.includes(ruleFolded)) {
      if (contained === undefined || text.length > contained.text.length) {
        contained = rule;
      }
    }
  }
  return foldedEqual ?? contained;
}

/**
 * Pure box-compatibility guard for position snaps: a measured box and a
 * rendered element box only describe the same surface when their widths are
 * close. Structures the synthesizer nests differently from the source (a
 * text-only span measured inside a decorated container, for example) must
 * not be force-moved onto the inner surface's coordinates. Rules without a
 * measured width (legacy) are always compatible.
 */
export function isBoxCompatible(rule: MeasuredRule, elementWidth: number): boolean {
  const measured = rule.boxWidth;
  if (measured === undefined || !Number.isFinite(measured)) return true;
  if (!Number.isFinite(elementWidth)) return true;
  return Math.abs(elementWidth - measured) <= Math.max(8, measured * 0.15);
}

/** JSON payload escaped for embedding inside generated source code. */
function embedJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replaceAll('\\u2028', '\\\\u2028')
    .replaceAll('\\u2029', '\\\\u2029');
}

/**
 * Pure text-verbatim snap (remediation record #11): returns the corpus text
 * when the rendered text is a decorated variant of it (invented bullets,
 * punctuation, or whitespace drift) and differs from it, so rendered text
 * becomes the measured corpus string verbatim. Wrapper text that merely
 * contains the rule is never clobbered. `undefined` = leave untouched.
 *
 * Compatibility is judged on the alphanumeric content (case-folded,
 * decoration stripped): it must be non-empty and equal. Symbol-only strings
 * never snap (they cannot match a differing rule anyway).
 */
export function selectTextSnapTarget(
  elementText: string,
  ruleText: string,
): string | undefined {
  const current = elementText.trim();
  const target = ruleText.trim();
  if (target.length === 0 || current === target) return undefined;
  const alnum = (s: string): string => s.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const currentAlnum = alnum(current);
  const targetAlnum = alnum(target);
  if (currentAlnum.length > 0 && currentAlnum === targetAlnum) return target;
  return undefined;
}

/**
 * Emits the generated project's `src/geometry-replay.ts` from measured
 * evidence, or `null` when no route carries measurable geometry (the
 * generated project then keeps its previous behavior exactly).
 */
export function generateGeometryReplayModule(routes: CrawlRoute[]): ProjectFile | null {
  const groups = buildReplayGroups(routes);
  if (Object.keys(groups).length === 0) return null;

  const content = [
    '/**',
    ' * apograph measured-geometry replay (generated from the evidence bundle).',
    ' *',
    ' * Enforces the measured rendered typography and wrap geometry of the',
    " * source site's text (computed at capture time) on the generated DOM, per",
    ' * viewport, so type scale and line wrapping reproduce the measured ground',
    ' * truth. Values below come entirely from the run evidence.',
    ' *',
    ' * This file is generated by apograph synthesis — regenerate instead of',
    ' * editing; a fresh clone replaces it wholesale.',
    ' */',
    '',
    `const RULE_GROUPS = ${embedJson(groups)};`,
    '',
    "const MANAGED = ['font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform', 'text-align', 'width', 'max-width', 'white-space', 'margin-top', 'margin-left'];",
    '',
    'let installed = false;',
    'let managedElements = [];',
    'let scheduled = false;',
    '',
    'export function matchRule(rules, elementText, claimed) {',
    '  const trimmed = elementText.trim();',
    '  const folded = trimmed.toUpperCase();',
    '  let foldedEqual;',
    '  let contained;',
    '  for (const rule of rules) {',
    '    if (claimed.has(rule)) continue;',
    '    const text = rule.text.trim();',
    '    if (text.length === 0) continue;',
    '    if (text === trimmed) return rule;',
    '    const ruleFolded = text.toUpperCase();',
    '    if (ruleFolded === folded) {',
    '      if (foldedEqual === undefined) foldedEqual = rule;',
    '      continue;',
    '    }',
    '    if (text.length >= 4 && folded.includes(ruleFolded)) {',
    '      if (contained === undefined || text.length > contained.text.length) {',
    '        contained = rule;',
    '      }',
    '    }',
    '  }',
    '  return foldedEqual ?? contained;',
    '}',
    '',
    'function collectTextElements() {',
    '  const elements = [];',
    '  const seen = new Set();',
    '  const root = document.body ?? document.documentElement;',
    '  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);',
    '  let node;',
    '  while ((node = walker.nextNode()) !== null) {',
    "    const text = node.textContent ?? '';",
    '    if (text.trim().length === 0) continue;',
    '    const parent = node.parentElement;',
    '    if (parent === null || seen.has(parent)) continue;',
    '    seen.add(parent);',
    '    elements.push(parent);',
    '  }',
    '  return elements;',
    '}',
    '',
    'function isTextOnly(element) {',
    '  for (const node of element.childNodes) {',
    '    if (node.nodeType !== Node.TEXT_NODE && node.nodeType !== Node.COMMENT_NODE) return false;',
    '  }',
    '  return true;',
    '}',
    '',
    'export function selectTextSnapTarget(elementText, ruleText) {',
    '  const current = elementText.trim();',
    '  const target = ruleText.trim();',
    "  if (target.length === 0 || current === target) return undefined;",
    "  const alnum = (s) => s.toUpperCase().replace(/[^\\p{L}\\p{N}]+/gu, '');",
    '  const currentAlnum = alnum(current);',
    '  const targetAlnum = alnum(target);',
    '  if (currentAlnum.length > 0 && currentAlnum === targetAlnum) return target;',
    '  return undefined;',
    '}',
    '',
    'export function boxCompatible(rule, elementWidth) {',
    '  const measured = rule.boxWidth;',
    '  if (measured === undefined || !Number.isFinite(measured)) return true;',
    '  if (!Number.isFinite(elementWidth)) return true;',
    '  return Math.abs(elementWidth - measured) <= Math.max(8, measured * 0.15);',
    '}',
    '',
    'function clearManaged() {',
    '  for (const element of managedElements) {',
    '    for (const property of MANAGED) element.style.removeProperty(property);',
    '  }',
    '  managedElements = [];',
    '}',
    '',
    'export function applyMeasuredGeometryPass() {',
    "  const key = (location.pathname.replace(/\\/+$/, '') || '/');",
    '  const group = RULE_GROUPS[key];',
    '  clearManaged();',
    '  if (group === undefined) return;',
    '  const mobile = window.innerWidth < 768;',
    '  const primary = mobile ? group.m : group.d;',
    '  const fallback = mobile ? group.d : group.m;',
    '  const rules = primary.length > 0 ? primary : fallback;',
    '  if (rules.length === 0) return;',
    '  const claimed = new Set();',
    '  const matched = [];',
    '  for (const element of collectTextElements()) {',
    "    const text = (element.textContent ?? '').trim();",
    '    if (text.length === 0) continue;',
    '    const rule = matchRule(rules, text, claimed);',
    '    if (rule === undefined) continue;',
    '    claimed.add(rule);',
    '    // Verbatim corpus snap: decorated variants (invented bullets,',
    '    // punctuation drift) become the measured corpus text exactly.',
    '    const snap = selectTextSnapTarget(text, rule.text);',
    '    if (snap !== undefined && isTextOnly(element)) element.textContent = snap;',
    '    const style = rule.style;',
    "    if (style.fs !== undefined) element.style.setProperty('font-size', style.fs);",
    "    if (style.fw !== undefined) element.style.setProperty('font-weight', style.fw);",
    "    if (style.lh !== undefined) element.style.setProperty('line-height', style.lh);",
    "    if (style.ls !== undefined) element.style.setProperty('letter-spacing', style.ls);",
    "    element.style.setProperty('text-transform', style.tt ?? 'none');",
    "    if (style.align !== undefined) element.style.setProperty('text-align', style.align);",
    "    if (rule.nowrap === true) element.style.setProperty('white-space', 'nowrap');",
    '    if (rule.width !== undefined) {',
    "      element.style.setProperty('width', String(rule.width) + 'px');",
    "      element.style.setProperty('max-width', '100%');",
    '    }',
    '    managedElements.push(element);',
    '    matched.push({ element, rule });',
    '  }',
    '  // Horizontal snap: measured boxes carry absolute document lefts, so',
    '  // each same-surface match is nudged (margin-left) onto its measured',
    '  // left. Entries are processed outermost-first: moving a container moves',
    '  // its descendants, whose corrections then read the shifted position.',
    '  const ordered = [...matched].sort((a, b) =>',
    '    a.element.contains(b.element) ? -1 : b.element.contains(a.element) ? 1 : 0,',
    '  );',
    '  for (const entry of ordered) {',
    '    const target = entry.rule.left;',
    '    if (target === undefined) continue;',
    '    const rect = entry.element.getBoundingClientRect();',
    '    if (!boxCompatible(entry.rule, rect.width)) continue;',
    '    const delta = target - (rect.left + window.scrollX);',
    "    if (!Number.isFinite(delta) || Math.abs(delta) < 0.5 || Math.abs(delta) > 400) continue;",
    '    const current = Number.parseFloat(getComputedStyle(entry.element).marginLeft);',
    '    const base = Number.isFinite(current) ? current : 0;',
    "    entry.element.style.setProperty('margin-left', String(Math.round((base + delta) * 10) / 10) + 'px');",
    '  }',
    '  // Vertical rhythm snap: measured boxes carry absolute tops from the',
    '  // source site, so each matched element is nudged (margin-top) onto its',
    '  // measured line. Processing in document order keeps the cascade',
    '  // consistent: every adjustment shifts only what comes after it.',
    '  for (const entry of matched) {',
    '    const target = entry.rule.top;',
    '    if (target === undefined) continue;',
    '    const rect = entry.element.getBoundingClientRect();',
    '    const delta = target - (rect.top + window.scrollY);',
    "    if (!Number.isFinite(delta) || Math.abs(delta) < 0.5 || Math.abs(delta) > 400) continue;",
    '    const current = Number.parseFloat(getComputedStyle(entry.element).marginTop);',
    '    const base = Number.isFinite(current) ? current : 0;',
    "    entry.element.style.setProperty('margin-top', String(Math.round((base + delta) * 10) / 10) + 'px');",
    '  }',
    '}',
    '',
    'function schedule() {',
    '  if (scheduled) return;',
    '  scheduled = true;',
    '  setTimeout(() => { scheduled = false; applyMeasuredGeometryPass(); }, 50);',
    '}',
    '',
    '/** Installs the replay pass (idempotent): initial apply + DOM/viewport resync. */',
    'export function installGeometryReplay() {',
    "  if (installed || typeof document === 'undefined') return;",
    '  installed = true;',
    '  applyMeasuredGeometryPass();',
    '  const observer = new MutationObserver(schedule);',
    '  observer.observe(document.documentElement, { childList: true, subtree: true });',
    "  window.addEventListener('resize', schedule);",
    "  window.addEventListener('popstate', schedule);",
    "  window.addEventListener('load', schedule);",
    '  if (document.fonts !== undefined && document.fonts !== null && document.fonts.ready !== undefined) {',
    '    document.fonts.ready.then(() => schedule(), () => {});',
    '  }',
    '}',
    '',
    'export { RULE_GROUPS };',
    '',
  ].join('\n');

  return { path: 'src/geometry-replay.ts', content };
}
