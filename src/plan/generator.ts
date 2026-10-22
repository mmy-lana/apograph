/**
 * apograph — Plan generator (Phase 3: Plan).
 *
 * Deterministically derives the authoritative synthesis plan from the
 * evidence bundle manifest: PascalCase component names from URL paths,
 * design tokens aggregated across every crawled route, and interactions
 * inferred from a11y-tree roles (`button`, `dialog`, `tab`, `form`).
 *
 * The generated plan is always unapproved (`approved: false`) — approval is
 * granted exclusively by the interactive gate in `src/plan/gate.ts`.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { A11yNode, CrawlRoute, EvidenceManifest, ModularTextSpans } from '../types.js';
import { slugForPath } from '../utils/fs-safe.js';
import { ApographPlanSchema } from './schema.js';
import type { ApographPlan, InferredInteraction, PlanRoute } from './schema.js';

// ---------------------------------------------------------------------------
// Evidence loading & plan persistence
// ---------------------------------------------------------------------------

/** Default evidence manifest location. */
export const DEFAULT_EVIDENCE_DIR = '.apograph/evidence';

/** Default plan file name inside the evidence directory. */
export const PLAN_FILENAME = 'apograph-plan.json';

/** Strict structural validation for one route record of an evidence bundle. */
const EvidenceRouteSchema = z.object({
  url: z.string().url(),
  path: z.string().regex(/^\/[^\r\n]*$/),
  title: z.string(),
  desktopScreenshot: z.string().nullable(),
  mobileScreenshot: z.string().nullable(),
  a11yTree: z.object({ role: z.string() }).passthrough(),
  tokens: z.object({ colors: z.record(z.string()), fonts: z.array(z.string()), spacing: z.array(z.string()), radii: z.array(z.string()) }).passthrough(),
}).passthrough();

/** Strict structural validation for evidence consumed by synthesis/verification. */
const EvidenceManifestSchema = z.object({
  targetUrl: z.string().url(),
  crawledAt: z.string().min(1),
  stats: z.object({
    pagesCrawled: z.number().int().nonnegative(),
    linksDiscovered: z.number().int().nonnegative(),
    assetsDownloaded: z.number().int().nonnegative(),
    assetsFailed: z.number().int().nonnegative(),
    externalAssets: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
  }),
  routes: z.array(EvidenceRouteSchema).max(500),
  assets: z.array(z.object({ originalUrl: z.string().url(), localPath: z.string().nullable(), status: z.enum(['downloaded', 'failed', 'external']) }).passthrough()).max(2000),
  diagnostics: z.object({ skippedUrls: z.array(z.object({ url: z.string(), reason: z.string() })), failedNavigations: z.array(z.object({ url: z.string(), reason: z.string() })), uncapturedResources: z.array(z.object({ url: z.string(), reason: z.string() })), redirectAliases: z.array(z.object({ from: z.string().url(), to: z.string().url(), settleTimeMs: z.number().nonnegative() })) }),
});

function manifestFromUnknown(raw: unknown, source: string): EvidenceManifest {
  const parsed = EvidenceManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid apograph evidence manifest: ${source}`);
  return parsed.data as EvidenceManifest;
}

/**
 * Reads one modular evidence JSON file, failing with an explicit, actionable
 * error (which file, which route) instead of an opaque ENOENT or parse throw.
 */
async function readModularJsonFile(filePath: string, description: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (cause) {
    throw new Error(`Missing modular evidence file: ${filePath} (${description})`, { cause });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(`Corrupt modular evidence file: ${filePath} (${description})`, { cause });
  }
}

/** True when the evidence dir uses the modular `routes/<slug>/` layout. */
async function hasModularRouteLayout(evidenceDir: string): Promise<boolean> {
  try {
    return (await readdir(join(evidenceDir, 'routes'))).length > 0;
  } catch {
    return false;
  }
}

/**
 * Reassembles one full `CrawlRoute` from a `routes/<slug>/` directory
 * (`route.json` + `a11y.json` + `text-spans.json`).
 */
async function readModularRoute(routeDir: string, routePath: string): Promise<CrawlRoute> {
  const description = `route ${routePath}`;
  const routeMeta = (await readModularJsonFile(join(routeDir, 'route.json'), description)) as Record<string, unknown>;
  const a11yTree = await readModularJsonFile(join(routeDir, 'a11y.json'), `${description} a11y tree`);
  const spans = (await readModularJsonFile(join(routeDir, 'text-spans.json'), `${description} text spans`)) as Partial<ModularTextSpans> | null;

  const merged: Record<string, unknown> = {
    ...routeMeta,
    a11yTree,
    textSpans: Array.isArray(spans?.desktop) ? spans.desktop : [],
    ...(Array.isArray(spans?.mobile) ? { mobileTextSpans: spans.mobile } : {}),
  };

  const parsed = EvidenceRouteSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`Invalid modular evidence route: ${routeDir} (${description})`);
  }
  return parsed.data as CrawlRoute;
}

/**
 * Reads and validates the evidence bundle under `.apograph/evidence/` (or a
 * custom evidence directory) against the evidence manifest shape.
 *
 * Supports both storage layouts transparently:
 * - modular (per-route evidence): `manifest.json` is a lightweight index and
 *   the full `EvidenceManifest` is hydrated from `assets.json` plus each
 *   `routes/<slug>/` sub-bundle;
 * - legacy monolithic: a single `manifest.json` holds the entire crawl.
 */
export async function loadEvidenceManifest(
  evidenceDir: string = DEFAULT_EVIDENCE_DIR,
): Promise<EvidenceManifest> {
  const manifestPath = join(evidenceDir, 'manifest.json');
  const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;

  if (!(await hasModularRouteLayout(evidenceDir))) {
    // Legacy monolithic manifest: nothing to hydrate.
    return manifestFromUnknown(raw, manifestPath);
  }

  // Canonical global asset registry; tolerate partial bundles missing it.
  let assets: unknown = raw['assets'] ?? [];
  try {
    assets = JSON.parse(await readFile(join(evidenceDir, 'assets.json'), 'utf8')) as unknown;
  } catch {
    // Fall back to whatever the root index carries (legacy-compatible).
  }

  const routeStubs = Array.isArray(raw['routes']) ? raw['routes'] : [];
  const hydratedRoutes: CrawlRoute[] = [];
  for (const stub of routeStubs) {
    const record = (stub ?? {}) as Record<string, unknown>;
    const path = typeof record.path === 'string' ? record.path : '/';
    const slug = typeof record.slug === 'string' ? record.slug : slugForPath(path);
    hydratedRoutes.push(await readModularRoute(join(evidenceDir, 'routes', slug), path));
  }

  return manifestFromUnknown(
    { ...raw, routes: hydratedRoutes, assets },
    manifestPath,
  );
}

/**
 * Route-scoped evidence reader: reads only `routes/<slug>/route.json`,
 * `routes/<slug>/a11y.json`, and `routes/<slug>/text-spans.json` for a single
 * route, so per-page synthesis never has to hold every route's a11y tree and
 * text spans in memory at once. Falls back to extracting the route from a
 * legacy monolithic `manifest.json` when the bundle predates the modular
 * layout.
 */
export async function loadRouteEvidence(
  evidenceDir: string,
  routePath: string,
): Promise<CrawlRoute> {
  if (await hasModularRouteLayout(evidenceDir)) {
    return readModularRoute(join(evidenceDir, 'routes', slugForPath(routePath)), routePath);
  }

  const manifestPath = join(evidenceDir, 'manifest.json');
  const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  const routes = Array.isArray(raw['routes']) ? raw['routes'] : [];
  const match = routes.find(
    (entry) => ((entry ?? {}) as Record<string, unknown>).path === routePath,
  );
  if (match === undefined) {
    throw new Error(`Route not found in evidence manifest: ${routePath} (${manifestPath})`);
  }
  const parsed = EvidenceRouteSchema.safeParse(match);
  if (!parsed.success) {
    throw new Error(`Invalid apograph evidence route: ${routePath} (${manifestPath})`);
  }
  return parsed.data as CrawlRoute;
}

/** Writes a plan to disk as pretty-printed JSON. */
export async function writePlanFile(
  planPath: string,
  plan: ApographPlan,
): Promise<void> {
  await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Plan derivation
// ---------------------------------------------------------------------------

/** Derives a clean app name from the target URL's hostname. */
function appNameFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    const slug = host.replace(/[^-a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug.length > 0 ? slug : 'apograph-app';
  } catch {
    return 'apograph-app';
  }
}

/**
 * Derives a PascalCase component name from a URL path:
 * `/` -> `HomePage`, `/about` -> `AboutPage`, `/blog/post` -> `BlogPostPage`,
 * `/pricing-plans` -> `PricingPlansPage`.
 */
export function componentNameForPath(path: string): string {
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((segment) =>
      segment
        .replace(/[^a-zA-Z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(''),
    )
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) return 'HomePage';
  return `${segments.join('')}Page`;
}

/**
 * Derives unique PascalCase component names for a set of URL paths: base
 * names from {@link componentNameForPath}, with deterministic numeric
 * suffixes in the stem for collisions (`/` + `/home` -> `HomePage`,
 * `Home2Page`). Names stay schema-safe identifiers (`...Page`), and the same
 * path list always yields the same names.
 */
export function uniqueComponentNames(paths: readonly string[]): string[] {
  const used = new Map<string, number>();
  return paths.map((path) => {
    const base = componentNameForPath(path);
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    if (count === 1) return base;
    const stem = base.endsWith('Page') ? base.slice(0, -'Page'.length) : base;
    return `${stem}${count}Page`;
  });
}

/** Flattens an a11y tree into a node list. */
function flattenA11yTree(node: A11yNode): A11yNode[] {
  const nodes: A11yNode[] = [node];
  for (const child of node.children ?? []) {
    nodes.push(...flattenA11yTree(child));
  }
  return nodes;
}

/** Button-name heuristics mapped to interactions. */
const BUTTON_NAME_PATTERNS: Array<{ pattern: RegExp; interaction: InferredInteraction }> = [
  { pattern: /menu|burger|hamburger|nav/i, interaction: 'mobile-menu' },
  { pattern: /expand|collapse|accordion|details|read more|show more|faq/i, interaction: 'accordion' },
  { pattern: /submit|send|sign in|log in|register|contact/i, interaction: 'form-submit' },
];

/**
 * Infers interactions for one route from its a11y tree, keyed off the
 * interactive roles `tab`/`tablist` (tabs), `form` (form-submit), `dialog`
 * (mobile-menu), and `button` (name-heuristic mobile-menu / accordion /
 * form-submit). Returns `['none']` when no interactive role is present.
 */
export function inferInteractions(a11yTree: A11yNode): InferredInteraction[] {
  const found = new Set<InferredInteraction>();
  const nodes = flattenA11yTree(a11yTree);

  for (const node of nodes) {
    const role = node.role.toLowerCase();

    if (role === 'tab' || role === 'tablist') found.add('tabs');
    if (role === 'form') found.add('form-submit');
    if (role === 'dialog') found.add('mobile-menu');

    if (role === 'button') {
      for (const { pattern, interaction } of BUTTON_NAME_PATTERNS) {
        if (node.name !== undefined && pattern.test(node.name)) {
          found.add(interaction);
        }
      }
    }
  }

  if (found.size === 0) {
    return ['none'];
  }
  return [...found];
}

/** Aggregates design tokens across every crawled route (union, sorted). */
function aggregateDesignTokens(manifest: EvidenceManifest): ApographPlan['designSystem'] {
  const colors = new Map<string, string>();
  const fonts = new Set<string>();
  const spacing = new Set<string>();
  const radii = new Set<string>();

  for (const route of manifest.routes) {
    for (const [key, value] of Object.entries(route.tokens.colors)) {
      colors.set(key, value);
    }
    for (const font of route.tokens.fonts) fonts.add(font);
    for (const space of route.tokens.spacing) spacing.add(space);
    for (const radius of route.tokens.radii) radii.add(radius);
  }

  return {
    colors: Object.fromEntries(colors),
    fonts: [...fonts].sort(),
    spacing: [...spacing].sort(),
    radii: [...radii].sort(),
  };
}

/** Builds the generator's assumption list from manifest facts. */
function deriveAssumptions(manifest: EvidenceManifest): string[] {
  const assumptions: string[] = [
    'Stack is fixed to react-vite-tailwind by Phase 3 policy.',
    'Component names are derived deterministically from URL paths.',
  ];

  if (manifest.stats.externalAssets > 0) {
    assumptions.push(
      `${manifest.stats.externalAssets} asset(s) were referenced cross-origin and not mirrored; ` +
        'the synthesized UI may reference their original remote URLs.',
    );
  }
  if (manifest.stats.pagesCrawled < manifest.stats.linksDiscovered) {
    assumptions.push(
      `The crawl visited ${manifest.stats.pagesCrawled} of ${manifest.stats.linksDiscovered} ` +
        'discovered links; unvisited routes are not represented in this plan.',
    );
  }

  return assumptions;
}

/** Builds the generator's unknowns list from evidence gaps. */
function deriveUnknowns(manifest: EvidenceManifest): string[] {
  const unknowns: string[] = [];

  if (manifest.routes.length === 0) {
    unknowns.push('No routes were crawled; the plan has no pages to synthesize.');
    return unknowns;
  }

  if (manifest.routes.every((route) => Object.keys(route.tokens.colors).length === 0)) {
    unknowns.push('No color tokens were captured; synthesizer defaults will apply.');
  }
  if (manifest.routes.every((route) => route.tokens.fonts.length === 0)) {
    unknowns.push('No font families were captured; synthesizer defaults will apply.');
  }

  const passive = manifest.routes.filter(
    (route) => inferInteractions(route.a11yTree).length === 1 &&
      inferInteractions(route.a11yTree)[0] === 'none',
  );
  if (passive.length > 0) {
    unknowns.push(
      `No interactive roles were detected on ${passive.length} route(s) ` +
        `(${passive.map((route) => route.path).join(', ')}); they will be synthesized as static pages.`,
    );
  }

  return unknowns;
}

/**
 * Derives an unapproved plan from an evidence manifest. Pure: performs no
 * I/O. Persist the result with {@link writePlanFile}, then seek approval via
 * the interactive gate.
 */
export function createPlanFromEvidence(manifest: EvidenceManifest): ApographPlan {
  const componentNames = uniqueComponentNames(manifest.routes.map((route) => route.path));
  const routes: PlanRoute[] = manifest.routes.map((route, index) => ({
    path: route.path,
    title: route.title,
    componentName: componentNames[index] as string,
    included: true,
    inferredInteractions: inferInteractions(route.a11yTree),
  }));

  return {
    targetUrl: manifest.targetUrl,
    appName: appNameFromUrl(manifest.targetUrl),
    stack: 'react-vite-tailwind',
    version: 1,
    approved: false,
    routes,
    designSystem: aggregateDesignTokens(manifest),
    assumptions: deriveAssumptions(manifest),
    unknowns: deriveUnknowns(manifest),
  };
}

/** Validates a plan payload against the authoritative schema. */
export function validatePlan(raw: unknown): ApographPlan {
  return ApographPlanSchema.parse(raw);
}
