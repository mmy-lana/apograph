/**
 * apograph — Multi-stage modular synthesis (Phase 4).
 *
 * Synthesizes a pure, standalone React 19.3 + Vite + React Router v7 +
 * Tailwind CSS 4.3 + lucide-react frontend from an approved plan:
 *
 *   Stage 1  Design tokens  -> deterministic `src/index.css` (@theme block).
 *   Stage 2  Shared layout  -> `Navbar.tsx` (mobile drawer) + `Footer.tsx`.
 *   Stage 3  Route pages    -> one component per included route, with
 *                              functional client-side state for tabs,
 *                              accordions, and mock form submissions.
 *   Stage 4  Router         -> deterministic `App.tsx` + `main.tsx`.
 *
 * Stages 2 and 3 prefer multimodal (vision) LLM synthesis using the route's
 * dual-viewport screenshots, a11y tree, and design tokens; when no model is
 * reachable they fall back to deterministic compile-ready templates, so the
 * pipeline always produces a complete project.
 */

import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { AssetEntry, CrawlRoute, DesignTokens, EvidenceManifest, ProjectFile } from '../types.js';
import { assertNoSymlinkComponents, resolveContainedPath } from '../utils/fs-safe.js';
import type { ApographPlan, PlanRoute } from '../plan/schema.js';
import type { ProgressHandle } from '../utils/progress.js';
import { NULL_PROGRESS } from '../utils/progress.js';
import { resolveModelId, resolveProviderName } from '../config/models.js';
import { redactSecrets } from '../config/validate.js';
import { ProviderAuthError } from './llm.js';
import {
  formatA11yTreeForVisionPrompt,
  formatAssetMapForPrompt,
  formatTextSpansForPrompt,
  formatTokensForVisionPrompt,
  generateFilesWithVision,
  loadRouteScreenshots,
} from './vision.js';
import type { ScreenshotImage } from './vision.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Optional synthesis callbacks (terminal integration, resumption). */
export interface ModularSynthesisCallbacks {
  /**
   * Starts a live progress spinner for a stage label; must return a handle
   * that the stage stops when it completes.
   */
  startProgress?: (label: string) => ProgressHandle;
  /**
   * Route paths to skip because their page files already exist on disk
   * (checkpoint resumption).
   */
  skipRoutePaths?: string[];
  /** Invoked after a route page has been synthesized (resumption tracking). */
  onRouteCompleted?: (path: string) => void;
}

/** Input for {@link synthesizeModularProject}. */
export interface ModularSynthesisInput {
  plan: ApographPlan;
  manifest: EvidenceManifest;
  /** Evidence bundle directory (screenshots + mirrored assets). */
  evidenceDir: string;
  /** Terminal progress + resumption hooks. */
  callbacks?: ModularSynthesisCallbacks;
}

/** Outcome of one synthesis stage (explicit reporting — no silent fallback). */
export interface StageOutcome {
  /** Stage identifier (e.g. `stage-2: shared layout`, `stage-3: route /`). */
  stage: string;
  /** How the stage's output was produced. */
  status: 'synthesized' | 'degraded-fallback' | 'failed';
  /** Redacted failure reason (present on degraded-fallback / failed). */
  reason?: string;
}

/** Result of a modular synthesis run. */
export interface ModularSynthesisResult {
  files: ProjectFile[];
  /** Stage labels completed through the vision LLM. */
  visionStages: string[];
  /** Stage labels completed via deterministic fallback templates. */
  fallbackStages: string[];
  /** Per-stage outcomes: synthesized, degraded-fallback, or failed. */
  stageOutcomes: StageOutcome[];
  /** Overall run verdict derived from stageOutcomes. */
  runStatus: 'success' | 'degraded' | 'failed';
  /** Route paths whose page files this run synthesized. */
  synthesizedRoutePaths: string[];
  /** Route paths skipped because they already existed (resumption). */
  skippedRoutePaths: string[];
}

/**
 * Derives the run verdict from per-stage outcomes: any `failed` stage makes
 * the run `failed`; otherwise any `degraded-fallback` makes it `degraded`;
 * an empty outcome list (deterministic-only stages) is `success`.
 */
export function computeRunStatus(
  stageOutcomes: StageOutcome[],
): 'success' | 'degraded' | 'failed' {
  if (stageOutcomes.some((outcome) => outcome.status === 'failed')) return 'failed';
  if (stageOutcomes.some((outcome) => outcome.status === 'degraded-fallback')) {
    return 'degraded';
  }
  return 'success';
}

/**
 * Exit-code policy for one synthesis run: `success` exits 0; `degraded`
 * exits 1 unless `--allow-degraded` is set; `failed` always exits 1.
 */
export function exitCodeForRunStatus(
  runStatus: 'success' | 'degraded' | 'failed',
  allowDegraded: boolean,
): number {
  if (runStatus === 'success') return 0;
  if (runStatus === 'degraded' && allowDegraded) return 0;
  return 1;
}

/**
 * Records one stage outcome, replacing any prior outcome for the same stage
 * name (used by the post-synthesis backfill to re-mark a stage whose emitted
 * output was replaced by a deterministic template).
 */
export function upsertStageOutcome(
  stageOutcomes: StageOutcome[],
  outcome: StageOutcome,
): void {
  const index = stageOutcomes.findIndex((entry) => entry.stage === outcome.stage);
  if (index === -1) stageOutcomes.push(outcome);
  else stageOutcomes[index] = outcome;
}

// ---------------------------------------------------------------------------
// Dynamic model-route reporting (spec s6.1)
// ---------------------------------------------------------------------------

/**
 * Formats the active model route for progress output (spec s6.1): hardcoded
 * provider strings are banned from the progress layer; provider and model
 * are resolved from the live model route, e.g. `via z-ai (glm-5.3-flash)`
 * or `via ollama (apograph-qwen35:9b-8k)`.
 */
export function formatModelRouteLabel(provider: string, modelId: string): string {
  return `via ${provider} (${modelId})`;
}

// ---------------------------------------------------------------------------
// Shared synthesis system prompt
// ---------------------------------------------------------------------------

const SYSTEM_GUIDELINES = [
  'You are an expert frontend engineer synthesizing a standalone React application.',
  'Target stack (fixed): React 19.3, Vite, React Router v7 (imports from "react-router"),',
  'Tailwind CSS v4 (CSS-first config in src/index.css via @theme), lucide-react icons.',
  'Rules:',
  '1. React 19 functional components with hooks only — no class components.',
  '2. Style strictly with Tailwind CSS utility classes. Match the screenshots',
  '   exactly: arbitrary value utilities are encouraged and expected — use',
  '   bg-[#080f1c], text-cyan-400, gradient utilities (bg-gradient-to-r',
  '   from-cyan-400 to-blue-500), opacity and blur utilities whenever they',
  '   reproduce the reference visuals. Semantic @theme tokens (bg-background,',
  '   text-foreground, border-border, text-muted-foreground) are also',
  '   available. Never reference --color-apograph-N variables; use the',
  '   provided reduced palette or direct hex values from the screenshots.',
  '3. Use lucide-react for every icon. Never invent SVG icon paths.',
  '4. Match the provided screenshots: desktop shot = >=1024px layout,',
  '   mobile shot = <768px layout. Reproduce the visual hierarchy, spacing rhythm,',
  '   and content structure faithfully.',
  '5. Reference mirrored images with their local path (/assets/<filename>) —',
  '   never their original remote URLs.',
  '6. The Navbar must use a sticky blurred header: className must include',
  '   `sticky top-0 z-50 backdrop-blur bg-background/80 border-b` so content',
  '   scrolls under a frosted header (bg-background comes from @theme and',
  '   carries the source site\'s extracted canvas color).',
  '7. Forms must include realistic HTML validation (required, type="email"),',
  '   a success toast/banner after submit, and mock persistence via',
  "   localStorage.setItem('apograph_submissions', ...).",
  '8. Every file must be complete and compile-ready — no placeholders, no TODOs,',
  '   no truncation, no markdown fences inside file contents.',
  '- Always use type-only imports for React types: `import type { FormEvent, ReactNode } from \'react\'`.',
  '- When rendering icons from lucide-react in maps, lists, or components, store the component reference and render as `<item.icon className="..." />`, or store JSX elements directly `icon: <Shield className="..." />`. Never assign string names and component references to the same property.',
  '- Check the asset descriptions before linking images. Only use assets named `hero-bg` or `*-bg` for section backgrounds. Use card/thumbnail assets for card items.',
  '- Never render a <header> or <nav> inside route pages (e.g. HomePage.tsx). The shared Navbar and Footer are already rendered globally by the layout wrapper. Page components must start directly with their own unique hero or top section.',
  '',
  'CRITICAL LAYOUT ARCHITECTURE RULES (NON-NEGOTIABLE):',
  '- Layout Architecture: Page sections must stack vertically in normal document flow inside <main className="flex min-h-screen w-full flex-col bg-background text-foreground">. Never position whole sections with `absolute` or `fixed` over other sections.',
  '- STRICT PROHIBITION ON WHOLE-SECTION ABSOLUTE POSITIONING: NEVER use `absolute inset-0`, `fixed inset-0`, or absolute positioning on top-level <section> or container wrappers. Every section must sit in natural vertical flow (e.g. `<section className="w-full py-16 sm:py-24">`). `position: absolute` is ONLY permitted for background/decorative elements inside a `relative` parent container.',
  '- SECTION INTEGRITY: Only render sections that visually belong to THIS page. Do not invent or pull cards, badges, or content from other pages.',
  '- FOOTER CONTRACT: Footer.tsx must be a static block container at the bottom of the page (`<footer className="w-full border-t border-border bg-background py-12">`). NEVER use `fixed`, `sticky`, or `absolute` on Footer.tsx.',
  '- CARD IMAGES: For card grids or list items, if a specific dedicated visual asset for that item does not exist, use a clean placeholder icon/gradient. Never assign background crops, full-page crops, or logo assets to card content.',
].join('\n');

// ---------------------------------------------------------------------------
// Canvas theme resolution (spec s4.1, s4.2)
// ---------------------------------------------------------------------------

/** True when a `#rrggbb` color is perceptually dark (luminance < 0.5). */
export function isDarkCanvasColor(hex: string): boolean {
  const match = hex.match(/^#([0-9a-fA-F]{6})$/);
  if (match === null) return false;
  const value = Number.parseInt(match[1] as string, 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance < 0.5;
}

/**
 * Resolves the dominant canvas background across captured routes (spec s4.1):
 * the most frequent non-transparent computed body background. Routes without
 * an extracted canvas (blank or legacy evidence) are ignored. Falls back to
 * `#ffffff` only when no route yielded a canvas color.
 */
export function resolveDominantCanvas(
  routes: Array<{ tokens: DesignTokens }>,
): string {
  const counts = new Map<string, number>();
  for (const route of routes) {
    const canvas = route.tokens.canvas?.backgroundColor;
    if (canvas === undefined) continue;
    if (!/^#[0-9a-fA-F]{6}$/.test(canvas)) continue;
    counts.set(canvas, (counts.get(canvas) ?? 0) + 1);
  }

  let dominant: string | null = null;
  let dominantCount = 0;
  for (const [color, count] of counts) {
    if (count > dominantCount) {
      dominant = color;
      dominantCount = count;
    }
  }

  return dominant ?? '#ffffff';
}

// ---------------------------------------------------------------------------
// Stage 1 — deterministic design tokens -> src/index.css
// ---------------------------------------------------------------------------

/**
 * Deterministically generates `src/index.css` for Tailwind CSS v4: the
 * `@import "tailwindcss"` entry plus a `@theme` block. The background token
 * is the extracted dominant canvas color (spec s4.2) — never a hardcoded
 * white — with foreground/border/muted derived from canvas luminance.
 */
export function generateIndexCss(
  designSystem: ApographPlan['designSystem'],
  canvasBackgroundColor?: string,
): string {
  const canvas = canvasBackgroundColor ?? '#ffffff';
  const dark = isDarkCanvasColor(canvas);
  const foreground = dark ? '#f8fafc' : '#171717';
  const border = dark ? 'rgba(255, 255, 255, 0.1)' : '#e5e7eb';
  const mutedForeground = dark ? 'rgba(248, 250, 252, 0.62)' : '#525252';

  const lines: string[] = [
    '/* src/index.css — generated deterministically by apograph from plan design tokens. */',
    '/* Canvas background extracted from the source site (spec s4.1/s4.2). */',
    '@import "tailwindcss";',
    '',
    '@theme {',
    `  --color-background: ${canvas};`,
    `  --color-foreground: ${foreground};`,
    `  --color-border: ${border};`,
    `  --color-muted-foreground: ${mutedForeground};`,
  ];

  const colorValues = [...new Set(Object.values(designSystem.colors))];
  colorValues.forEach((value, index) => {
    lines.push(`  --color-apograph-${index}: ${value};`);
  });

  const FONT_SIZE_RE = /^\d+(\.\d+)?(px|rem|em|pt|%)$/;
  designSystem.fonts.forEach((font, index) => {
    if (FONT_SIZE_RE.test(font)) return;
    const family = font.split(',')[0]?.trim().replace(/['"]/g, '');
    if (family === undefined || family.length === 0) return;
    lines.push(`  --font-apograph-${index}: "${family}";`);
  });

  designSystem.spacing.forEach((value, index) => {
    lines.push(`  --spacing-apograph-${index}: ${value};`);
  });

  designSystem.radii.forEach((value, index) => {
    lines.push(`  --radius-apograph-${index}: ${value};`);
  });

  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Deterministic fallback templates (Stages 2–4)
// ---------------------------------------------------------------------------

/** Deterministic compile-ready Navbar with a responsive mobile drawer. */
export function generateNavbarTemplate(appName: string, routes: PlanRoute[]): string {
  const links = routes.map((route) => {
    const label = route.title.length > 0 ? route.title : route.componentName;
    return `  { to: '${route.path}', label: '${escapeString(label)}' },`;
  });

  return [
    'import { useState } from \'react\';',
    'import { Link, NavLink } from \'react-router\';',
    'import { Menu, X } from \'lucide-react\';',
    '',
    'const NAV_LINKS = [',
    ...(links.length > 0 ? links : ['  { to: \'/\', label: \'Home\' },']),
    '];',
    '',
    'export function Navbar() {',
    '  const [open, setOpen] = useState(false);',
    '',
    '  return (',
    '    <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur">',
    '      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">',
    '        <Link to="/" className="text-lg font-semibold tracking-tight text-foreground">',
    `          ${escapeString(appName)}`,
    '        </Link>',
    '',
    '        <div className="hidden items-center gap-6 md:flex">',
    '          {NAV_LINKS.map((link) => (',
    '            <NavLink',
    '              key={link.to}',
    '              to={link.to}',
    '              className={({ isActive }) =>',
    "                'text-sm font-medium transition-colors ' +",
    "                (isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')",
    '              }',
    '            >',
    '              {link.label}',
    '            </NavLink>',
    '          ))}',
    '        </div>',
    '',
    '        <button',
    '          type="button"',
    '          aria-label="Toggle navigation menu"',
    '          aria-expanded={open}',
    '          onClick={() => setOpen((value) => !value)}',
    '          className="inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground md:hidden"',
    '        >',
    '          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}',
    '        </button>',
    '      </nav>',
    '',
    '      {open ? (',
    '        <div className="border-t border-border bg-background md:hidden">',
    '          <div className="space-y-1 px-4 py-3">',
    '            {NAV_LINKS.map((link) => (',
    '              <NavLink',
    '                key={link.to}',
    '                to={link.to}',
    '                onClick={() => setOpen(false)}',
    '                className={({ isActive }) =>',
    "                  'block rounded-md px-3 py-2 text-sm font-medium ' +",
    "                  (isActive ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground')",
    '                }',
    '              >',
    '                {link.label}',
    '              </NavLink>',
    '            ))}',
    '          </div>',
    '        </div>',
    '      ) : null}',
    '    </header>',
    '  );',
    '}',
    '',
  ].join('\n');
}

/** Deterministic compile-ready Footer. */
export function generateFooterTemplate(appName: string, routes: PlanRoute[]): string {
  const links = routes.map((route) => {
    const label = route.title.length > 0 ? route.title : route.componentName;
    return `            <Link key="${escapeString(route.path)}" to="${escapeString(route.path)}" className="text-sm text-muted-foreground hover:text-foreground">${escapeString(label)}</Link>`;
  });

  return [
    "import { Link } from 'react-router';",
    '',
    'export function Footer() {',
    '  return (',
    '    <footer className="w-full border-t border-border bg-background">',
    '      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 sm:flex-row sm:px-6">',
    `        <p className="text-sm text-muted-foreground">&copy; {new Date().getFullYear()} ${escapeString(appName)}</p>`,
    '        <nav className="flex flex-wrap gap-6">',
    ...(links.length > 0 ? links : ['            <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">Home</Link>']),
    '        </nav>',
    '      </div>',
    '    </footer>',
    '  );',
    '}',
    '',
  ].join('\n');
}

/** Deterministic compile-ready route page implementing the plan's interactions. */
export function generatePageTemplate(route: PlanRoute): string {
  const interactions = route.inferredInteractions.filter(
    (interaction) => interaction !== 'none',
  );
  const title = route.title.length > 0 ? route.title : route.componentName;

  const imports: string[] = [];
  const needsState =
    interactions.includes('tabs') ||
    interactions.includes('accordion') ||
    interactions.includes('form-submit');
  if (needsState) imports.push("import { useState } from 'react';");
  if (interactions.includes('form-submit')) {
    imports.push("import type { FormEvent } from 'react';");
  }
  if (interactions.includes('accordion')) imports.push("import { ChevronDown } from 'lucide-react';");
  if (interactions.includes('form-submit')) imports.push("import { Send } from 'lucide-react';");

  const state: string[] = [];
  if (interactions.includes('tabs')) {
    state.push("  const [activeTab, setActiveTab] = useState('overview');");
  }
  if (interactions.includes('accordion')) {
    state.push('  const [openItem, setOpenItem] = useState<number | null>(null);');
  }
  if (interactions.includes('form-submit')) {
    state.push(
      "  const [formState, setFormState] = useState<'idle' | 'submitting' | 'sent'>('idle');",
      '',
      '  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {',
      '    event.preventDefault();',
      '    const form = event.currentTarget;',
      '    if (!form.reportValidity()) return;',
      "    setFormState('submitting');",
      '',
      '    const data = new FormData(form);',
      '    const submission = {',
      "      name: String(data.get('name') ?? ''),",
      "      email: String(data.get('email') ?? ''),",
      "      message: String(data.get('message') ?? ''),",
      '      submittedAt: new Date().toISOString(),',
      '    };',
      '',
      '    try {',
      "      const stored = window.localStorage.getItem('apograph_submissions');",
      '      const existing: unknown = stored === null ? [] : JSON.parse(stored);',
      '      const submissions = Array.isArray(existing) ? existing : [];',
      '      submissions.push(submission);',
      "      window.localStorage.setItem('apograph_submissions', JSON.stringify(submissions));",
      '    } catch {',
      '      // localStorage unavailable (private mode, etc.) — mock submit still succeeds.',
      '    }',
      '',
      '    form.reset();',
      "    setFormState('sent');",
      '  };',
    );
  }

  const sections: string[] = [];

  if (interactions.includes('tabs')) {
    sections.push([
      '      <div className="mt-12">',
      "        <div role=\"tablist\" aria-label=\"Sections\" className=\"flex gap-2 border-b border-neutral-200\">",
      "          {TABS.map((tab) => (",
      '            <button',
      '              key={tab.id}',
      '              type="button"',
      '              role="tab"',
      '              aria-selected={activeTab === tab.id}',
      '              onClick={() => setActiveTab(tab.id)}',
      "              className={'px-4 py-2 text-sm font-medium transition-colors ' +",
      "                (activeTab === tab.id",
      "                  ? 'border-b-2 border-neutral-900 text-neutral-900'",
      "                  : 'text-neutral-500 hover:text-neutral-800')}",
      '            >',
      '              {tab.label}',
      '            </button>',
      '          ))}',
      '        </div>',
      '        <div role="tabpanel" className="pt-4 text-neutral-600">',
      '          {TABS.find((tab) => tab.id === activeTab)?.content}',
      '        </div>',
      '      </div>',
    ].join('\n'));
  }

  if (interactions.includes('accordion')) {
    sections.push([
      '      <div className="mt-12 space-y-3">',
      '        {ACCORDION_ITEMS.map((item, index) => (',
      '          <div key={item.title} className="rounded-lg border border-neutral-200">',
      '            <button',
      '              type="button"',
      '              aria-expanded={openItem === index}',
      '              onClick={() => setOpenItem(openItem === index ? null : index)}',
      '              className="flex w-full items-center justify-between px-4 py-3 text-left font-medium text-neutral-800"',
      '            >',
      '              {item.title}',
      "              <ChevronDown",
      "                className={'h-4 w-4 transition-transform ' + (openItem === index ? 'rotate-180' : '')}",
      '              />',
      '            </button>',
      '            {openItem === index ? (',
      '              <p className="px-4 pb-3 text-sm text-neutral-600">{item.content}</p>',
      '            ) : null}',
      '          </div>',
      '        ))}',
      '      </div>',
    ].join('\n'));
  }

  if (interactions.includes('form-submit')) {
    sections.push([
      '      <form',
      '        className="mt-12 max-w-lg space-y-4"',
      '        onSubmit={handleSubmit}',
      '      >',
      '        <div>',
      '          <label htmlFor="name" className="block text-sm font-medium text-neutral-800">Name</label>',
      '          <input id="name" name="name" required minLength={2} className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm" />',
      '        </div>',
      '        <div>',
      '          <label htmlFor="email" className="block text-sm font-medium text-neutral-800">Email</label>',
      '          <input id="email" name="email" type="email" required className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm" />',
      '        </div>',
      '        <div>',
      '          <label htmlFor="message" className="block text-sm font-medium text-neutral-800">Message</label>',
      '          <textarea id="message" name="message" rows={4} required minLength={10} className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm" />',
      '        </div>',
      "        <button type=\"submit\" disabled={formState === 'submitting'} className=\"inline-flex items-center gap-2 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60\">",
      "          <Send className=\"h-4 w-4\" />",
      "          {formState === 'submitting' ? 'Sending\u2026' : 'Send message'}",
      '        </button>',
      "        {formState === 'sent' ? (",
      '          <div role="status" aria-live="polite" className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">',
      '            Thanks — your message was recorded (mock submission).',
      '          </div>',
      '        ) : null}',
      '      </form>',
    ].join('\n'));
  }

  const body = [
    `    <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6">`,
    `      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">${escapeString(title)}</h1>`,
    '      <p className="mt-4 max-w-2xl text-neutral-600">',
    `        ${escapeString(title)} — synthesized by apograph from captured evidence.`,
    '      </p>',
    ...(sections.length > 0 ? ['', ...sections] : []),
    '    </section>',
  ].join('\n');

  return [
    ...imports,
    '',
    ...(interactions.includes('tabs')
      ? [
          'const TABS = [',
          "  { id: 'overview', label: 'Overview', content: 'An overview of this section.' },",
          "  { id: 'details', label: 'Details', content: 'Further details about this section.' },",
          "  { id: 'faq', label: 'FAQ', content: 'Answers to common questions.' },",
          '];',
          '',
        ]
      : []),
    ...(interactions.includes('accordion')
      ? [
          'const ACCORDION_ITEMS = [',
          "  { title: 'How does this work?', content: 'Each item expands and collapses on click.' },",
          "  { title: 'Is it responsive?', content: 'Yes — the layout adapts to every viewport.' },",
          "  { title: 'Can I customize it?', content: 'Every section is a plain React component.' },",
          '];',
          '',
        ]
      : []),
    `export function ${route.componentName}() {`,
    ...(state.length > 0 ? ['', ...state] : []),
    '  return (',
    body,
    '  );',
    '}',
    '',
  ].join('\n');
}

/** Escapes a string for embedding inside single-quoted TS string literals. */
function escapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
}

// ---------------------------------------------------------------------------
// Stage 4 — deterministic router assembly
// ---------------------------------------------------------------------------

/** Deterministic `src/App.tsx` wiring React Router v7 over included routes. */
export function generateAppTsx(plan: ApographPlan): string {
  const routes = plan.routes.filter((route) => route.included);
  const home = routes.find((route) => route.path === '/') ?? routes[0];

  const routeElements = routes.map((route) => {
    const path = route.path === '/' ? '/' : route.path;
    return [
      `            <Route path="${escapeString(path)}" element={<${route.componentName} />} />`,
    ].join('');
  });

  const wildcard = home
    ? [`            <Route path="*" element={<${home.componentName} />} />`]
    : [];

  return [
    "import { BrowserRouter, Route, Routes } from 'react-router';",
    "import { Navbar } from './components/Navbar';",
    "import { Footer } from './components/Footer';",
    ...routes.map((route) => `import { ${route.componentName} } from './pages/${route.componentName}';`),
    '',
    'export default function App() {',
    '  return (',
    '    <BrowserRouter>',
    '      <div className="flex min-h-screen flex-col bg-background text-foreground">',
    '        <Navbar />',
    '        <main className="flex-1">',
    '          <Routes>',
    ...routeElements,
    ...wildcard,
    '          </Routes>',
    '        </main>',
    '        <Footer />',
    '      </div>',
    '    </BrowserRouter>',
    '  );',
    '}',
    '',
  ].join('\n');
}

/** Deterministic `src/main.tsx` entrypoint. */
export function generateMainTsx(): string {
  return [
    "import { StrictMode } from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import './index.css';",
    "import App from './App';",
    '',
    "const rootElement = document.getElementById('root');",
    'if (rootElement !== null) {',
    '  createRoot(rootElement).render(',
    '    <StrictMode>',
    '      <App />',
    '    </StrictMode>,',
    '  );',
    '}',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Asset reference rewriting & mirroring
// ---------------------------------------------------------------------------

/**
 * Rewrites original asset URLs in generated file contents to their mirrored
 * `/assets/<filename>` paths, using the evidence manifest's asset entries.
 */
export function rewriteAssetReferences(
  files: ProjectFile[],
  assets: AssetEntry[],
): ProjectFile[] {
  const downloaded = assets.filter(
    (asset) => asset.status === 'downloaded' && asset.localPath !== null,
  );

  if (downloaded.length === 0) return files;

  return files.map((file) => {
    let content = file.content;
    for (const asset of downloaded) {
      const filename = basename(asset.localPath as string);
      content = content.split(asset.originalUrl).join(`/assets/${filename}`);
    }
    return { path: file.path, content };
  });
}

/**
 * Copies every mirrored asset from `<evidenceDir>/assets/*` into
 * `<projectDir>/public/assets/`. Returns the number of files copied.
 */
export async function copyMirroredAssets(
  assetsDir: string,
  projectDir: string,
): Promise<number> {
  const sourceDir = resolve(assetsDir);
  const targetDir = join(resolve(projectDir), 'public', 'assets');

  let entries: string[];
  try {
    entries = await readdir(sourceDir);
  } catch {
    return 0;
  }

  await mkdir(targetDir, { recursive: true });
  await assertNoSymlinkComponents(resolve(projectDir), targetDir);

  let copied = 0;
  for (const entry of entries) {
    const sourcePath = resolveContainedPath(sourceDir, entry);
    const targetPath = resolveContainedPath(targetDir, entry);
    await assertNoSymlinkComponents(sourceDir, sourcePath);
    await assertNoSymlinkComponents(targetDir, targetPath);
    await copyFile(sourcePath, targetPath);
    copied += 1;
  }
  return copied;
}

// ---------------------------------------------------------------------------
// Vision stage helpers
// ---------------------------------------------------------------------------

/** Finds the manifest route backing a plan route (by path). */
function manifestRouteFor(planRoute: PlanRoute, manifest: EvidenceManifest): CrawlRoute | undefined {
  return manifest.routes.find((route) => route.path === planRoute.path);
}

/** True when an asset filename looks like a global logo or favicon. */
function isGlobalAsset(asset: AssetEntry): boolean {
  const name = (asset.localPath ?? asset.originalUrl).toLowerCase();
  return /logo|favicon|icon|brand|og-image/.test(name);
}

/**
 * Filters the manifest's asset list to only those relevant for a specific
 * route: assets whose provenance includes this route, plus global logos/icons.
 */
function routeScopedAssets(assets: AssetEntry[], routePath: string): AssetEntry[] {
  return assets.filter(
    (asset) =>
      isGlobalAsset(asset) ||
      asset.routes === undefined ||
      asset.routes.length === 0 ||
      asset.routes.includes(routePath),
  );
}

/** Matches a `.map(...)` call over an inline array with no object literals. */
const INLINE_EMPTY_ARRAY_MAP_RE = /\[\s*(?:\/\/[^\n]*\n\s*)*\]\s*\.map\(/;

/**
 * True when an LLM-generated Navbar looks compile-viable: exports `Navbar`
 * and does not map over an untyped inline empty array (`never[]` source of
 * `Property 'path' does not exist on type 'never'` build failures).
 */
function isNavbarViable(content: string): boolean {
  if (!content.includes('export function Navbar')) return false;
  if (INLINE_EMPTY_ARRAY_MAP_RE.test(content)) return false;
  return true;
}

/**
 * Formats the SPA-aware modal capture section of the stage-3 page prompt:
 * when the route has modalCaptures, each captured overlay is listed by
 * accessible name and trigger so the synthesized page implements them as
 * openable overlays driven by useState.
 */
function modalCapturePromptLines(route: CrawlRoute | undefined): string[] {
  const modals = route?.modalCaptures ?? [];
  if (modals.length === 0) return [];
  return [
    'Modal states captured (implement these as openable overlays with useState):',
    ...modals.map(
      (modal) =>
        `- "${modal.modalName}" — triggered by ${modal.triggerSelector}`,
    ),
    '',
  ];
}

/** Runs one vision LLM stage, falling back to deterministic output on failure. */
async function runVisionStage(
  stage: string,
  label: string,
  text: string,
  screenshots: ScreenshotImage[],
  fallback: () => ProjectFile[],
  result: ModularSynthesisResult,
  startProgressFn?: (label: string) => ProgressHandle,
): Promise<ProjectFile[]> {
  const progress = startProgressFn ? startProgressFn(label) : null;

  try {
    const files = await generateFilesWithVision(text, SYSTEM_GUIDELINES, screenshots, {
      // Surface bounded-retry waits on the live spinner while waiting.
      onRetry: (message) => progress?.message(message),
    });
    if (
      files.length === 0 ||
      files.every((f) => f.content.trim().length === 0)
    ) {
      throw new Error('model returned no files or all files had empty content');
    }
    result.visionStages.push(stage);
    result.stageOutcomes.push({ stage, status: 'synthesized' });
    progress?.stop(`${label} — done`);
    return files;
  } catch (cause) {
    // Invalid credentials (HTTP 401/403) abort the run — they must never be
    // silently masked by a deterministic template fallback.
    if (cause instanceof ProviderAuthError) throw cause;
    const reason = redactSecrets(cause instanceof Error ? cause.message : String(cause));
    console.warn(`[apograph] ${stage}: vision synthesis unavailable (${reason}); using deterministic template.`);
    result.fallbackStages.push(stage);
    try {
      const files = fallback();
      if (files.length === 0 || files.every((f) => f.content.trim().length === 0)) {
        throw new Error('deterministic fallback produced no usable files');
      }
      result.stageOutcomes.push({ stage, status: 'degraded-fallback', reason });
      progress?.stop(`${label} — fallback`);
      return files;
    } catch (fallbackCause) {
      // Even the deterministic fallback broke: record the stage as failed so
      // the run can never report plain success.
      const fallbackReason = redactSecrets(
        fallbackCause instanceof Error ? fallbackCause.message : String(fallbackCause),
      );
      result.stageOutcomes.push({ stage, status: 'failed', reason: fallbackReason });
      progress?.stop(`${label} — failed`);
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Runs the four-stage modular synthesis for an approved plan. The returned
 * file set is the complete `src/` tree; the emitter adds the scaffold
 * (package.json, vite.config.ts, index.html, tsconfig) around it.
 */
export async function synthesizeModularProject(
  input: ModularSynthesisInput,
): Promise<ModularSynthesisResult> {
  const { plan, manifest, evidenceDir } = input;
  if (!plan.approved) {
    throw new Error('Synthesis requires an explicitly approved plan.');
  }
  const included = plan.routes.filter((route) => route.included);
  const callbacks = input.callbacks;
  const skipPaths = new Set(callbacks?.skipRoutePaths ?? []);

  // Active model route, resolved dynamically for progress reporting (s6.1).
  const provider = resolveProviderName();
  const modelId = resolveModelId(provider);

  const result: ModularSynthesisResult = {
    files: [],
    visionStages: [],
    fallbackStages: [],
    stageOutcomes: [],
    runStatus: 'success',
    synthesizedRoutePaths: [],
    skippedRoutePaths: [],
  };

  // --- Stage 1: design tokens -> src/index.css (deterministic) -----------
  // Dominant canvas across healthy captured routes (spec s4.1/s4.2).
  const canvasColor = resolveDominantCanvas(manifest.routes);
  const indexCss: ProjectFile = {
    path: 'src/index.css',
    content: generateIndexCss(plan.designSystem, canvasColor),
  };

  // --- Stage 2: shared layout (Navbar + Footer) ---------------------------
  const layoutRoute = manifest.routes[0];
  const layoutScreenshots = layoutRoute
    ? await loadRouteScreenshots(layoutRoute, evidenceDir)
    : [];

  const layoutPrompt = [
    'Synthesize the shared layout components for this application.',
    '',
    `App name: ${plan.appName}`,
    `Navigation links (React Router v7, <NavLink>): ${included
      .map((route) => `${route.path} ("${route.title.length > 0 ? route.title : route.componentName}")`)
      .join(', ')}`,
    '',
    `Canvas background (extracted from the source site): ${canvasColor}.`,
    '   The page canvas must stay this color — never introduce white or',
    '   light backgrounds that do not appear in the screenshots.',
    '',
    'Reduced color palette (use these, or arbitrary Tailwind hex utilities',
    'like bg-[#080f1c] / text-cyan-400 / gradient utilities matching the',
    'screenshots — do NOT use --color-apograph-N variables):',
    formatTokensForVisionPrompt(layoutRoute?.tokens ?? plan.designSystem),
    '',
    'Mirrored image assets (reference as /assets/<filename>):',
    formatAssetMapForPrompt(manifest.assets),
    '',
    'Accessibility tree of the reference homepage:',
    layoutRoute ? formatA11yTreeForVisionPrompt(layoutRoute.a11yTree) : '(not captured)',
    '',
    formatTextSpansForPrompt(layoutRoute?.textSpans ?? []),
    '',
    'TEXT FIDELITY (critical): every span in the text corpus above must appear',
    'in the output verbatim, with its casing preserved. Gradient headline',
    'spans MUST keep their exact gradient definition (e.g. bg-clip-text with',
    'the listed background-image gradient) — never approximate gradient text',
    'from the screenshots by eye.',
    '',
    'MIRRORED ASSETS (critical): embed every mirrored image and logo directly',
    'via its /assets/<filename> path from the map below — the local files are',
    'byte-identical copies of the originals.',
    '',
    'The screenshots show the reference site: desktop (1280x800) first, then',
    'mobile (390x844). Reproduce the navbar/footer structure, content, and',
    'visual treatment from them.',
    '',
    'Emit exactly these files:',
    '1. src/components/Navbar.tsx — exported function Navbar; responsive;',
    '   sticky blurred header (className must include "sticky top-0 z-50',
    '   backdrop-blur bg-background/80 border-b"); on <768px a hamburger',
    '   (lucide-react Menu/X) toggles a client-side drawer with useState;',
    '   desktop shows inline links.',
    '   CRITICAL: declare the nav link list with an explicit type —',
    '   `const NAV_LINKS: Array<{ to: string; label: string }> = [...]` —',
    '   and NEVER map over an inline empty array `[].map(...)`: TypeScript',
    '   infers `never[]` and the build fails. If there are no extra links,',
    '   render no list at all.',
    '2. src/components/Footer.tsx — exported function Footer; matches the',
    '   screenshot footer content and links; must be a static block container',
    '   at the bottom of the page (className must include "w-full border-t',
    '   border-border bg-background py-12"); NEVER use fixed, sticky, or',
    '   absolute positioning.',
  ].join('\n');

  const layoutFiles = await runVisionStage(
    'stage-2: shared layout',
    `Synthesizing Navbar and Footer ${formatModelRouteLabel(provider, modelId)}`,
    layoutPrompt,
    layoutScreenshots,
    () => [
      { path: 'src/components/Navbar.tsx', content: generateNavbarTemplate(plan.appName, included) },
      { path: 'src/components/Footer.tsx', content: generateFooterTemplate(plan.appName, included) },
    ],
    result,
    callbacks?.startProgress ?? (() => NULL_PROGRESS),
  );

  // Guarantee Footer.tsx: local models sometimes emit only Navbar.tsx, which
  // breaks App.tsx's import. Always ensure the deterministic footer exists.
  const footerIndex = layoutFiles.findIndex(
    (file) => file.path === 'src/components/Footer.tsx',
  );
  if (footerIndex === -1) {
    layoutFiles.push({
      path: 'src/components/Footer.tsx',
      content: generateFooterTemplate(plan.appName, included),
    });
  }

  // Guarantee a viable Navbar: local models occasionally emit compile-breaking
  // navbars (missing export, or `.map()` over an inline empty array, which
  // TypeScript infers as `never[]`). Replace those with the deterministic
  // template so App.tsx's import always compiles.
  const navbarIndex = layoutFiles.findIndex(
    (file) => file.path === 'src/components/Navbar.tsx',
  );
  if (navbarIndex !== -1) {
    const navbar = layoutFiles[navbarIndex];
    if (navbar !== undefined && !isNavbarViable(navbar.content)) {
      console.warn(
        '[apograph] stage-2: LLM Navbar failed the viability check ' +
          '(missing export or untyped empty `.map()` list); using the deterministic template.',
      );
      layoutFiles[navbarIndex] = {
        path: 'src/components/Navbar.tsx',
        content: generateNavbarTemplate(plan.appName, included),
      };
    }
  } else {
    layoutFiles.push({
      path: 'src/components/Navbar.tsx',
      content: generateNavbarTemplate(plan.appName, included),
    });
  }

  // --- Stage 3: route pages -----------------------------------------------
  const pageFiles: ProjectFile[] = [];
  for (const route of included) {
    // Resumption: skip routes whose page files already exist on disk.
    if (skipPaths.has(route.path)) {
      result.skippedRoutePaths.push(route.path);
      continue;
    }

    const manifestRoute = manifestRouteFor(route, manifest);
    const screenshots = manifestRoute
      ? await loadRouteScreenshots(manifestRoute, evidenceDir)
      : [];

    const pagePrompt = [
      `Synthesize the page component for route ${route.path} (${route.componentName}).`,
      '',
      `Page title: ${route.title.length > 0 ? route.title : route.componentName}`,
      `Interactions to implement as client-side state (useState): ${route.inferredInteractions.join(', ')}`,
      '',
      `Canvas background (extracted from the source site): ${canvasColor}.`,
      '   Keep the page canvas this color; match text and accent colors with',
      '   arbitrary Tailwind hex utilities from the screenshots.',
      '',
      'Reduced color palette (use these, or arbitrary Tailwind hex utilities',
      'like bg-[#080f1c] / text-cyan-400 / gradient utilities matching the',
      'screenshots — do NOT use --color-apograph-N variables):',
      formatTokensForVisionPrompt(manifestRoute?.tokens ?? plan.designSystem),
      '',
      'Mirrored image assets (reference as /assets/<filename>):',
      formatAssetMapForPrompt(routeScopedAssets(manifest.assets, route.path)),
      '',
      'Accessibility tree of the reference page:',
      manifestRoute ? formatA11yTreeForVisionPrompt(manifestRoute.a11yTree) : '(not captured)',
      '',
      ...(modalCapturePromptLines(manifestRoute)),
      formatTextSpansForPrompt(manifestRoute?.textSpans ?? []),
      '',
      'TEXT FIDELITY (critical): every span in the text corpus above must appear',
      'in the output verbatim, with its casing preserved. Gradient headline',
      'spans MUST keep their exact gradient definition — never approximate',
      'gradient text from the screenshots by eye.',
      '',
      'MIRRORED ASSETS (critical): embed every mirrored image and logo directly',
      'via its /assets/<filename> path from the map below.',
      '',
      'The screenshots show this exact page: desktop (1280x800) first, then',
      'mobile (390x844). Reproduce the layout, sections, copy, and visual',
      'hierarchy faithfully. Implement functional interactions:',
      '- "tabs": clickable tab list switching visible content with useState.',
      '- "accordion": expandable items toggled with useState.',
      '- "form-submit": a form with realistic HTML validation (required,',
      '   type="email", minLength), a success toast/banner after submit, and',
      "   mock persistence via localStorage.setItem('apograph_submissions', ...)",
      '- "mobile-menu": handled by Navbar; ignore here.',
      '- "none": static content only.',
      '',
      `Emit exactly one file: src/pages/${route.componentName}.tsx with`,
      `export function ${route.componentName}(). Import nothing from the project`,
      'except lucide-react — Navbar/Footer are rendered by App.',
    ].join('\n');

    const files = await runVisionStage(
      `stage-3: route ${route.path}`,
      `Synthesizing page ${route.path} ${formatModelRouteLabel(provider, modelId)}`,
      pagePrompt,
      screenshots,
      () => [
        {
          path: `src/pages/${route.componentName}.tsx`,
          content: generatePageTemplate(route),
        },
      ],
      result,
      callbacks?.startProgress ?? (() => NULL_PROGRESS),
    );

    pageFiles.push(...files);
    result.synthesizedRoutePaths.push(route.path);
    callbacks?.onRouteCompleted?.(route.path);
  }

  // --- Stage 4: router assembly (deterministic) ----------------------------
  const appTsx: ProjectFile = { path: 'src/App.tsx', content: generateAppTsx(plan) };
  const mainTsx: ProjectFile = { path: 'src/main.tsx', content: generateMainTsx() };

  // --- Asset reference rewriting -------------------------------------------
  result.files = rewriteAssetReferences(
    [indexCss, ...layoutFiles, ...pageFiles, appTsx, mainTsx],
    manifest.assets,
  );

  result.runStatus = computeRunStatus(result.stageOutcomes);

  return result;
}
