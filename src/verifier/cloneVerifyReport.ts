/**
 * apograph — clone-verify report rendering.
 *
 * Terminal summary + JSON persistence for the live-vs-clone comparison
 * (`runCloneVerify` in `./cloneVerify.js`).
 */

import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CloneVerifyResult, CloneVerifyRoute } from './cloneVerify.js';
import { CLONE_VERIFY_REPORT_FILENAME } from './cloneVerify.js';

// ---------------------------------------------------------------------------
// JSON persistence
// ---------------------------------------------------------------------------

/** Writes the clone-verify result to `<outputDir>/clone-verify-report.json`. */
export async function writeCloneVerifyReport(
  outputDir: string,
  result: CloneVerifyResult,
): Promise<string> {
  const reportPath = join(resolve(outputDir), CLONE_VERIFY_REPORT_FILENAME);
  await writeFile(reportPath, JSON.stringify(result, null, 2), 'utf8');
  return reportPath;
}

// ---------------------------------------------------------------------------
// Terminal summary
// ---------------------------------------------------------------------------

/** Formats a percentage with one decimal place (e.g. `87.3`). */
function percent(value: number): string {
  return value.toFixed(1);
}

/** Formats a matched/total ratio for one route's font or color report. */
function matchedRatio(matched: string[], original: string[]): string {
  return `${matched.length}/${original.length}`;
}

/** Formats one route's summary line. */
function routeLine(route: CloneVerifyRoute): string {
  const flag = route.passed ? 'PASS' : 'FAIL';
  return (
    `[${flag}] ${route.path} ` +
    `pixel similarity: ${percent(route.pixelSimilarity)}% ` +
    `fonts: ${matchedRatio(route.fontReport.matched, route.fontReport.original)} matched ` +
    `colors: ${matchedRatio(route.colorReport.matched, route.colorReport.original)} matched`
  );
}

/**
 * Prints the human-readable clone-verify summary to stdout: per-route
 * pass/fail lines with similarity/font/color ratios, the animations found
 * in the original but missing from the clone, aggregate scores, and the
 * overall verdict.
 */
export function printCloneVerifyReport(result: CloneVerifyResult): void {
  const { summary } = result;

  console.log('');
  console.log(`apograph clone-verify — ${result.url}`);
  console.log(`Generated: ${result.generatedAt}`);

  console.log('');
  console.log('Route comparisons:');
  for (const route of result.routes) {
    console.log(routeLine(route));
  }

  console.log('');
  console.log('Animations detected in original but not in clone:');
  for (const route of result.routes) {
    const animations =
      route.animationsDetected.length > 0
        ? route.animationsDetected.join(', ')
        : '(none)';
    console.log(`${route.path} — ${animations}`);
  }

  const overallPassed = summary.passedRoutes === summary.totalRoutes;

  console.log('');
  console.log('Summary:');
  console.log(`Average pixel similarity: ${percent(summary.averageSimilarity)}%`);
  console.log(`Font match score: ${Math.round(summary.fontMatchScore)}%`);
  console.log(`Color match score: ${Math.round(summary.colorMatchScore)}%`);
  console.log(`Routes passed: ${summary.passedRoutes}/${summary.totalRoutes}`);

  console.log('');
  console.log(`Overall: ${overallPassed ? 'PASS' : 'FAIL'}`);
}
