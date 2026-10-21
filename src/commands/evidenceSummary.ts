/**
 * apograph — Pre-flight evidence summary (CLI `--dry-run`).
 *
 * Renders the evidence a crawl actually captured — route titles, harvested
 * text spans, mirrored image assets, screenshot paths, and the pre-flight
 * bot-check verdict — as a compact table so a run can be inspected before
 * any plan gate or LLM synthesis is attempted. Pure formatting: no I/O.
 */

import type { EvidenceManifest, RouteBotCheck } from '../types.js';

/** One rendered row of the pre-flight evidence summary table. */
export interface EvidenceSummaryRow {
  /** Route path (row key). */
  route: string;
  /** Document title captured for the route. */
  title: string;
  /** Visible text spans captured (desktop + mobile corpora combined). */
  textSpans: number;
  /** Mirrored image assets attributed to the route. */
  imageAssets: number;
  /** Bundle-relative screenshot path, or `(none)`. */
  screenshot: string;
  /** Bot-check verdict text (see {@link formatBotCheck}). */
  botCheck: string;
}

/** Column headers of the summary table, in render order. */
export const EVIDENCE_SUMMARY_HEADERS = [
  'Route',
  'Title',
  'Text spans',
  'Images',
  'Screenshot',
  'Bot check',
] as const;

/** Max rendered width of the title column (long titles are truncated). */
const MAX_TITLE_WIDTH = 40;

/** Max rendered width of the screenshot column. */
const MAX_SCREENSHOT_WIDTH = 44;

/** Formats a recorded bot-check verdict for the summary table. */
export function formatBotCheck(botCheck: RouteBotCheck | undefined): string {
  if (botCheck === undefined) return 'unchecked';
  if (botCheck.verdict === 'clean') return 'clean';
  return `blocked (${botCheck.signature ?? 'unknown'})`;
}

/** Truncates a cell to `width` display columns, marking the cut with `…`. */
function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(1, width - 1))}…`;
}

/**
 * Builds the per-route summary rows for an evidence manifest: title, text
 * span count (desktop + mobile corpora), attributed image asset count,
 * bundle-relative screenshot path, and bot-check verdict.
 */
export function buildEvidenceSummaryRows(manifest: EvidenceManifest): EvidenceSummaryRow[] {
  // Image assets attributed per route path (downloaded mirrors and visual
  // extracts both carry provenance in `asset.routes`).
  const imageCounts = new Map<string, number>();
  for (const asset of manifest.assets) {
    if (asset.status !== 'downloaded') continue;
    for (const path of asset.routes ?? []) {
      imageCounts.set(path, (imageCounts.get(path) ?? 0) + 1);
    }
  }

  return manifest.routes.map((route) => ({
    route: route.path,
    title: route.title.trim().length > 0 ? route.title.trim() : '(untitled)',
    textSpans: (route.textSpans?.length ?? 0) + (route.mobileTextSpans?.length ?? 0),
    imageAssets: imageCounts.get(route.path) ?? 0,
    screenshot: route.desktopScreenshot ?? route.mobileScreenshot ?? '(none)',
    botCheck: formatBotCheck(route.botCheck),
  }));
}

/** Renders the summary rows as a fixed-width ASCII table. */
export function formatEvidenceSummaryTable(rows: EvidenceSummaryRow[]): string {
  const cells: string[][] = rows.map((row) => [
    truncate(row.route, 24),
    truncate(row.title, MAX_TITLE_WIDTH),
    String(row.textSpans),
    String(row.imageAssets),
    truncate(row.screenshot, MAX_SCREENSHOT_WIDTH),
    row.botCheck,
  ]);

  const headers = [...EVIDENCE_SUMMARY_HEADERS];
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...cells.map((row) => (row[column] ?? '').length), 1),
  );

  const renderRow = (row: string[]): string =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
      .join('  ')
      .replace(/\s+$/, '');

  const separator = widths.map((width) => '-'.repeat(width)).join('  ');
  return [
    renderRow(headers),
    separator,
    ...cells.map(renderRow),
  ].join('\n');
}

/**
 * Builds the summary row used when the pre-flight bot check aborted the
 * crawl: there is no captured evidence, only the block verdict.
 */
export function blockedSummaryRow(
  url: string,
  botCheck: RouteBotCheck,
): EvidenceSummaryRow {
  return {
    route: '(crawl aborted)',
    title: url,
    textSpans: 0,
    imageAssets: 0,
    screenshot: '(none)',
    botCheck: formatBotCheck(botCheck),
  };
}
