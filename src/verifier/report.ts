/**
 * apograph — Verification report (Phase 5).
 *
 * Canonical shapes for the 3-tier verification result, persistence to
 * `<outputDir>/verification-report.json`, and the formatted terminal
 * summary printed after every verification run.
 */

import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Report filename, written into the verified project directory. */
export const REPORT_FILENAME = 'verification-report.json';

// ---------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------

/** Tier 1 result: tsc + vite build inside the output directory. */
export interface BuildCheck {
  success: boolean;
  /** True when `tsc --noEmit` passed. */
  tscPassed: boolean;
  /** True when `vite build` passed (only attempted when tsc passed). */
  vitePassed: boolean;
  /** Compiler / bundler error log lines. */
  errors: string[];
}

/** Tier 2 result: one route's headless smoke check. */
export interface RouteCheck {
  path: string;
  /** HTTP status of the navigation response. */
  httpStatus: number;
  /** True when the SPA root mounted visible DOM content. */
  domLoaded: boolean;
  /** Number of console `error` messages. */
  consoleErrorCount: number;
  consoleErrors: string[];
  /** Unhandled page exceptions. */
  exceptions: string[];
  success: boolean;
}

/** Tier 3 result: one route/viewport screenshot comparison. */
export interface VisualCheck {
  path: string;
  viewport: 'desktop' | 'mobile';
  /** Reference screenshot path from the evidence bundle (null when absent). */
  referenceScreenshot: string | null;
  /** Diff image path written under `.apograph-verification/` (null when not comparable). */
  diffImage: string | null;
  /** Mismatch percentage (null when not comparable). */
  mismatchPercent: number | null;
  /** Mismatch threshold in percent. */
  thresholdPercent: number;
  /** True when below threshold; null when not comparable. */
  passed: boolean | null;
  /** Human-readable note for skipped/absent comparisons. */
  note?: string;
}

/** Aggregate verdicts. */
export interface VerificationVerdict {
  passed: boolean;
  buildPassed: boolean;
  routesPassed: boolean;
  visualsPassed: boolean;
}

/** The full verification report. */
export interface VerificationReport {
  outputDir: string;
  evidenceDir: string;
  generatedAt: string;
  build: BuildCheck;
  routes: RouteCheck[];
  visuals: VisualCheck[];
  overall: VerificationVerdict;
  /** Diagnostic summary of remaining gaps. */
  diagnostics: string[];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Writes the report as pretty-printed JSON into the output directory. */
export async function writeVerificationReport(
  outputDir: string,
  report: VerificationReport,
): Promise<string> {
  const reportPath = join(resolve(outputDir), REPORT_FILENAME);
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  return reportPath;
}

// ---------------------------------------------------------------------------
// Terminal summary
// ---------------------------------------------------------------------------

/** Marker for a passing check. */
function mark(passed: boolean | null): string {
  if (passed === null) return '[SKIP]';
  return passed ? '[PASS]' : '[FAIL]';
}

/** Prints the formatted verification summary to stdout. */
export function printVerificationSummary(report: VerificationReport): void {
  const lines: string[] = [];

  lines.push(`apograph verification — ${report.outputDir}`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');

  // Build tier.
  lines.push(
    `Build:      ${mark(report.build.success)} ` +
      `tsc ${report.build.tscPassed ? 'ok' : 'FAILED'}, ` +
      `vite ${report.build.vitePassed ? 'ok' : 'FAILED'}`,
  );
  for (const error of report.build.errors.slice(0, 10)) {
    lines.push(`    ${error}`);
  }
  if (report.build.errors.length > 10) {
    lines.push(`    ... ${report.build.errors.length - 10} more error(s)`);
  }
  lines.push('');

  // Route tier.
  lines.push('Routes:');
  if (report.routes.length === 0) {
    lines.push('  (no routes checked)');
  }
  for (const route of report.routes) {
    lines.push(
      `  ${mark(route.success)} ${route.path.padEnd(24)} ` +
        `HTTP ${route.httpStatus} · DOM ${route.domLoaded ? 'loaded' : 'EMPTY'} · ` +
        `${route.consoleErrorCount} console error(s) · ${route.exceptions.length} exception(s)`,
    );
    for (const error of route.consoleErrors.slice(0, 3)) {
      lines.push(`      console: ${error.slice(0, 160)}`);
    }
    for (const exception of route.exceptions.slice(0, 3)) {
      lines.push(`      pageerror: ${exception.slice(0, 160)}`);
    }
  }
  lines.push('');

  // Visual tier.
  lines.push(
    `Visual fidelity (threshold ${report.visuals[0]?.thresholdPercent ?? 15}%):`,
  );
  if (report.visuals.length === 0) {
    lines.push('  (no visual comparisons)');
  }
  for (const visual of report.visuals) {
    const mismatch =
      visual.mismatchPercent !== null
        ? `${visual.mismatchPercent.toFixed(1)}%`
        : 'n/a';
    lines.push(
      `  ${mark(visual.passed)} ${`${visual.path} ${visual.viewport}`.padEnd(32)} ` +
        `mismatch ${mismatch}` +
        (visual.diffImage !== null ? ` · diff: ${visual.diffImage}` : ''),
    );
    if (visual.note !== undefined) {
      lines.push(`      ${visual.note}`);
    }
  }
  lines.push('');

  // Diagnostics.
  if (report.diagnostics.length > 0) {
    lines.push('Diagnostics:');
    for (const diagnostic of report.diagnostics) {
      lines.push(`  - ${diagnostic}`);
    }
    lines.push('');
  }

  lines.push(
    `Overall: ${mark(report.overall.passed)} ` +
      `(build ${report.overall.buildPassed ? 'pass' : 'fail'}, ` +
      `routes ${report.overall.routesPassed ? 'pass' : 'fail'}, ` +
      `visuals ${report.overall.visualsPassed ? 'pass' : 'fail'})`,
  );

  console.log(lines.join('\n'));
}
