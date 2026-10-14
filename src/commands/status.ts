/**
 * apograph — Multi-project status (`apograph status`).
 *
 * Scans `./output/` for generated projects, reads each project's
 * `verification-report.json` and `package.json`, and renders either boxed
 * Clack cards (1–3 projects) or a compact table of the 5 most recent
 * projects (4 or more; `--all` shows every row).
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import * as p from '@clack/prompts';

/** Options for {@link runStatusCommand}. */
export interface StatusCliOptions {
  /** Show all projects when there are 4 or more. */
  all: boolean;
}

/** Directory scanned for generated projects. */
const OUTPUT_DIR = './output';

/** Max rows rendered in table mode without --all. */
const TABLE_ROWS_WITHOUT_ALL = 5;

/** One scanned project's summary. */
interface ProjectStatus {
  name: string;
  /** Absolute project directory. */
  location: string;
  routes: number | null;
  buildPassed: boolean | null;
  /** Worst (max) visual mismatch percentage across compared viewports. */
  visualMismatchPercent: number | null;
  overallPassed: boolean | null;
  lastModified: Date;
}

/** Reads and parses a JSON file, or null when absent/invalid. */
async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Extracts a number-typed field from a report object. */
function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** True when a boolean-typed field is literally true. */
function isTrue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Scans one candidate directory into a project status (or null). */
async function scanProject(dir: string): Promise<ProjectStatus | null> {
  const hasReport = await readJson(join(dir, 'verification-report.json')).then(
    (report) => report !== null,
  );
  const packageJson = await readJson(join(dir, 'package.json'));
  if (!hasReport && packageJson === null) return null;

  const report = await readJson(join(dir, 'verification-report.json'));

  let routes: number | null = null;
  let buildPassed: boolean | null = null;
  let overallPassed: boolean | null = null;
  let visualMismatchPercent: number | null = null;

  if (report !== null) {
    const reportRoutes = report['routes'];
    routes = Array.isArray(reportRoutes) ? reportRoutes.length : null;

    const build = report['build'];
    if (typeof build === 'object' && build !== null) {
      buildPassed = isTrue((build as Record<string, unknown>)['success']);
    }

    const overall = report['overall'];
    if (typeof overall === 'object' && overall !== null) {
      overallPassed = isTrue((overall as Record<string, unknown>)['passed']);
    }

    const visuals = report['visuals'];
    if (Array.isArray(visuals)) {
      const mismatches = visuals
        .map((visual) => numberOf((visual as Record<string, unknown>)['mismatchPercent']))
        .filter((value): value is number => value !== null);
      if (mismatches.length > 0) {
        visualMismatchPercent = Math.max(...mismatches);
      }
    }
  }

  let lastModified = new Date(0);
  try {
    const info = await stat(dir);
    lastModified = info.mtime;
  } catch {
    // Directory vanished between readdir and stat — skip timestamp.
  }

  const name =
    typeof packageJson?.['name'] === 'string' && packageJson['name'].length > 0
      ? packageJson['name']
      : dir.split('/').pop() ?? 'unknown';

  return {
    name,
    location: dir,
    routes,
    buildPassed,
    visualMismatchPercent,
    overallPassed,
    lastModified,
  };
}

/** Human status line for a project card. */
function statusLine(project: ProjectStatus): string {
  if (project.overallPassed === true) {
    const mismatch =
      project.visualMismatchPercent !== null
        ? ` (visual mismatch: ${project.visualMismatchPercent.toFixed(1)}%)`
        : '';
    return `[COMPLETE] Verified${mismatch}`;
  }
  if (project.overallPassed === false) {
    return '[FAILED] Verification incomplete';
  }
  if (project.buildPassed === true) {
    return '[PARTIAL] Built, not fully verified';
  }
  return '[UNKNOWN] No verification report';
}

/** Renders boxed cards for up to 3 projects. */
function renderCards(projects: ProjectStatus[]): void {
  const header = `Apograph Workspace Status (${projects.length} project(s) found)`;
  const lines: string[] = [];

  for (const project of projects) {
    lines.push('');
    lines.push(`◇  ${project.name}`);
    lines.push(`│  Status:     ${statusLine(project)}`);
    lines.push(
      `│  Routes:     ${project.routes !== null ? project.routes : 'unknown'}`,
    );
    lines.push(
      `│  Modified:   ${project.lastModified.toLocaleString()}`,
    );
    lines.push(`│  Location:   ${project.location}`);
  }

  p.note(lines.join('\n'), header);
}

/** Renders the compact table for 4+ projects. */
function renderTable(projects: ProjectStatus[], showAll: boolean): void {
  const recent = [...projects].sort(
    (a, b) => b.lastModified.getTime() - a.lastModified.getTime(),
  );
  const rows = showAll ? recent : recent.slice(0, TABLE_ROWS_WITHOUT_ALL);
  const hidden = recent.length - rows.length;

  const rowsText = rows.map((project) => {
    const mismatch =
      project.visualMismatchPercent !== null
        ? `${project.visualMismatchPercent.toFixed(1)}%`
        : 'n/a';
    const state = project.overallPassed === true ? 'PASS' : project.overallPassed === false ? 'FAIL' : '----';
    return (
      `${project.name.padEnd(24).slice(0, 24)} ` +
      `${state.padEnd(6)} ` +
      `routes ${(project.routes ?? '-').toString().padEnd(4)} ` +
      `diff ${mismatch.padEnd(7)} ` +
      `${project.lastModified.toLocaleString()}`
    );
  });

  const lines = [
    `Apograph Workspace Status (${projects.length} project(s) found)`,
    '',
    ...rowsText,
  ];

  if (hidden > 0 && !showAll) {
    lines.push(`... and ${hidden} more project(s) (use 'apograph status --all' to see all).`);
  }

  p.note(lines.join('\n'), 'apograph status');
}

/** Runs the `apograph status` command. */
export async function runStatusCommand(options: StatusCliOptions): Promise<void> {
  const outputDir = resolve(OUTPUT_DIR);

  let entries: Dirent[] = [];
  try {
    entries = await readdir(outputDir, { withFileTypes: true });
  } catch {
    console.log(`No output directory found at ${outputDir}.`);
    console.log('Run `apograph clone <url>` to generate a project first.');
    return;
  }

  const projects: ProjectStatus[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const status = await scanProject(join(outputDir, entry.name));
    if (status !== null) projects.push(status);
  }

  if (projects.length === 0) {
    console.log(`No generated projects found under ${outputDir}.`);
    return;
  }

  if (projects.length <= 3) {
    renderCards(projects);
    return;
  }

  renderTable(projects, options.all);
}
