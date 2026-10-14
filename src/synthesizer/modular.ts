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
import type { AssetEntry, CrawlRoute, EvidenceManifest, ProjectFile } from '../types.js';
import type { ApographPlan, PlanRoute } from '../plan/schema.js';
import {
  formatA11yTreeForVisionPrompt,
  formatAssetMapForPrompt,
  formatTokensForVisionPrompt,
  generateFilesWithVision,
  loadRouteScreenshots,
} from './vision.js';
import type { ScreenshotImage } from './vision.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Input for {@link synthesizeModularProject}. */
export interface ModularSynthesisInput {
  plan: ApographPlan;
  manifest: EvidenceManifest;
  /** Evidence bundle directory (screenshots + mirrored assets). */
  evidenceDir: string;
}

/** Result of a modular synthesis run. */
export interface ModularSynthesisResult {
  files: ProjectFile[];
  /** Stage labels completed through the vision LLM. */
  visionStages: string[];
  /** Stage labels completed via deterministic fallback templates. */
  fallbackStages: string[];
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
  '2. Style strictly with Tailwind CSS utility classes. The @theme tokens from',
  '   src/index.css (colors, fonts, spacing, radii) are available as utilities',
  '   (e.g. bg-apograph-0, font-apograph-0, p-apograph-0, rounded-apograph-0).',
  '3. Use lucide-react for every icon. Never invent SVG icon paths.',
  '4. Match the provided screenshots: desktop shot = >=1024px layout,',
  '   mobile shot = <768px layout. Reproduce the visual hierarchy, spacing rhythm,',
  '   and content structure faithfully.',
  '5. Reference mirrored images with their local path (/assets/<filename>) —',
  '   never their original remote URLs.',
  '6. The Navbar must use a sticky blurred header: className must include',
  '   `sticky top-0 z-50 backdrop-blur bg-background/80 border-b` so content',
  '   scrolls under a frosted header (bg-background comes from @theme).',
  '7. Forms must include realistic HTML validation (required, type="email"),',
  '   a success toast/banner after submit, and mock persistence via',
  "   localStorage.setItem('apograph_submissions', ...).",
  '8. Every file must be complete and compile-ready — no placeholders, no TODOs,',
  '   no truncation, no markdown fences inside file contents.',
].join('\n');

// ---------------------------------------------------------------------------
// Stage 1 — deterministic design tokens -> src/index.css
// ---------------------------------------------------------------------------

/**
 * Deterministically generates `src/index.css` for Tailwind CSS v4: the
 * `@import "tailwindcss"` entry plus a `@theme` block mapping the plan's
 * aggregated design tokens to named CSS variables (exposed as bg-/text-/
 * font-/p-/rounded- utilities).
 */
export function generateIndexCss(designSystem: ApographPlan['designSystem']): string {
  const lines: string[] = [
    '/* src/index.css — generated deterministically by apograph from plan design tokens. */',
    '@import "tailwindcss";',
    '',
    '@theme {',
    '  --color-background: #ffffff;',
    '  --color-foreground: #171717;',
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
    '    <header className="sticky top-0 z-50 border-b border-neutral-200 bg-background/80 backdrop-blur">',
    '      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">',
    '        <Link to="/" className="text-lg font-semibold tracking-tight">',
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
    "                (isActive ? 'text-neutral-900' : 'text-neutral-600 hover:text-neutral-900')",
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
    '          className="inline-flex h-10 w-10 items-center justify-center rounded-md text-neutral-700 md:hidden"',
    '        >',
    '          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}',
    '        </button>',
    '      </nav>',
    '',
    '      {open ? (',
    '        <div className="border-t border-neutral-200 bg-white md:hidden">',
    '          <div className="space-y-1 px-4 py-3">',
    '            {NAV_LINKS.map((link) => (',
    '              <NavLink',
    '                key={link.to}',
    '                to={link.to}',
    '                onClick={() => setOpen(false)}',
    '                className={({ isActive }) =>',
    "                  'block rounded-md px-3 py-2 text-sm font-medium ' +",
    "                  (isActive ? 'bg-neutral-100 text-neutral-900' : 'text-neutral-700')",
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
    return `            <Link key="${escapeString(route.path)}" to="${escapeString(route.path)}" className="text-sm text-neutral-500 hover:text-neutral-700">${escapeString(label)}</Link>`;
  });

  return [
    "import { Link } from 'react-router';",
    '',
    'export function Footer() {',
    '  return (',
    '    <footer className="border-t border-neutral-200 bg-neutral-50">',
    '      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 sm:flex-row sm:px-6">',
    `        <p className="text-sm text-neutral-500">&copy; {new Date().getFullYear()} ${escapeString(appName)}</p>`,
    '        <nav className="flex flex-wrap gap-6">',
    ...(links.length > 0 ? links : ['            <Link to="/" className="text-sm text-neutral-500 hover:text-neutral-700">Home</Link>']),
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
    '      <div className="flex min-h-screen flex-col bg-white text-neutral-900">',
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

  let copied = 0;
  for (const entry of entries) {
    await copyFile(join(sourceDir, entry), join(targetDir, entry));
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

/** Runs one vision LLM stage, falling back to deterministic output on failure. */
async function runVisionStage(
  stage: string,
  text: string,
  screenshots: ScreenshotImage[],
  fallback: () => ProjectFile[],
  result: ModularSynthesisResult,
): Promise<ProjectFile[]> {
  try {
    const files = await generateFilesWithVision(text, SYSTEM_GUIDELINES, screenshots);
    if (files.length === 0) throw new Error('model returned no files');
    result.visionStages.push(stage);
    return files;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    console.warn(`[apograph] ${stage}: vision synthesis unavailable (${reason}); using deterministic template.`);
    result.fallbackStages.push(stage);
    return fallback();
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
  const included = plan.routes.filter((route) => route.included);

  const result: ModularSynthesisResult = {
    files: [],
    visionStages: [],
    fallbackStages: [],
  };

  // --- Stage 1: design tokens -> src/index.css (deterministic) -----------
  const indexCss: ProjectFile = {
    path: 'src/index.css',
    content: generateIndexCss(plan.designSystem),
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
    'Design tokens (available as Tailwind @theme utilities):',
    formatTokensForVisionPrompt(plan.designSystem),
    '',
    'Mirrored image assets (reference as /assets/<filename>):',
    formatAssetMapForPrompt(manifest.assets),
    '',
    'Accessibility tree of the reference homepage:',
    layoutRoute ? formatA11yTreeForVisionPrompt(layoutRoute.a11yTree) : '(not captured)',
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
    '2. src/components/Footer.tsx — exported function Footer; matches the',
    '   screenshot footer content and links.',
  ].join('\n');

  const layoutFiles = await runVisionStage(
    'stage-2: shared layout',
    layoutPrompt,
    layoutScreenshots,
    () => [
      { path: 'src/components/Navbar.tsx', content: generateNavbarTemplate(plan.appName, included) },
      { path: 'src/components/Footer.tsx', content: generateFooterTemplate(plan.appName, included) },
    ],
    result,
  );

  // --- Stage 3: route pages -----------------------------------------------
  const pageFiles: ProjectFile[] = [];
  for (const route of included) {
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
      'Design tokens (available as Tailwind @theme utilities):',
      formatTokensForVisionPrompt(manifestRoute?.tokens ?? plan.designSystem),
      '',
      'Mirrored image assets (reference as /assets/<filename>):',
      formatAssetMapForPrompt(manifest.assets),
      '',
      'Accessibility tree of the reference page:',
      manifestRoute ? formatA11yTreeForVisionPrompt(manifestRoute.a11yTree) : '(not captured)',
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
      pagePrompt,
      screenshots,
      () => [
        {
          path: `src/pages/${route.componentName}.tsx`,
          content: generatePageTemplate(route),
        },
      ],
      result,
    );

    pageFiles.push(...files);
  }

  // --- Stage 4: router assembly (deterministic) ----------------------------
  const appTsx: ProjectFile = { path: 'src/App.tsx', content: generateAppTsx(plan) };
  const mainTsx: ProjectFile = { path: 'src/main.tsx', content: generateMainTsx() };

  // --- Asset reference rewriting -------------------------------------------
  result.files = rewriteAssetReferences(
    [indexCss, ...layoutFiles, ...pageFiles, appTsx, mainTsx],
    manifest.assets,
  );

  return result;
}
