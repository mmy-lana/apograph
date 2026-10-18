/**
 * apograph — Project scaffolding & emission (Layer 5: Output, Phase 4+).
 *
 * Emits a pure, standalone multi-page frontend project (React 19.3 + Vite +
 * React Router v7 + Tailwind CSS 4.3 + lucide-react) — zero backend or
 * SQLite generation. The scaffold provides the deterministic root files
 * (package.json, vite.config.ts, index.html, tsconfig.json, README) around
 * the modular synthesis output; synthesized files win on path collisions.
 *
 * An overwrite guard protects existing output directories: without `force`,
 * interactive runs choose between update-in-place, full overwrite, or abort;
 * non-interactive runs safely merge (generated files overwrite, existing
 * project files are never deleted).
 */

import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as p from '@clack/prompts';
import type { ProjectFile, RouteMetadata } from '../types.js';
import { assertNoSymlinkComponents, assertSafeRelativePath, resolveContainedPath } from '../utils/fs-safe.js';

// ---------------------------------------------------------------------------
// Fixed target stack versions
// ---------------------------------------------------------------------------

const REACT_VERSION = '19.3.0';
const TAILWIND_VERSION = '4.3.3';
const REACT_ROUTER_VERSION = '^7.9.0';
const LUCIDE_REACT_VERSION = '^0.525.0';

// ---------------------------------------------------------------------------
// Root scaffold files
// ---------------------------------------------------------------------------

/** Escapes a string for safe embedding in HTML attribute/text content. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Builds the <head> body lines from extracted SEO / OpenGraph metadata. */
function buildHeadLines(appName: string, metadata?: RouteMetadata): string[] {
  const title = metadata?.ogTitle ?? metadata?.title ?? appName;
  const description = metadata?.ogDescription ?? metadata?.description;

  const lines = [
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `    <title>${escapeHtml(title)}</title>`,
  ];

  if (description !== undefined) {
    lines.push(`    <meta name="description" content="${escapeHtml(description)}" />`);
  }
  if (metadata?.favicon !== undefined) {
    lines.push(`    <link rel="icon" href="${escapeHtml(metadata.favicon)}" />`);
  }
  if (metadata?.ogTitle !== undefined) {
    lines.push(`    <meta property="og:title" content="${escapeHtml(metadata.ogTitle)}" />`);
  }
  if (metadata?.ogDescription !== undefined) {
    lines.push(
      `    <meta property="og:description" content="${escapeHtml(metadata.ogDescription)}" />`,
    );
  }
  if (metadata?.ogImage !== undefined) {
    lines.push(`    <meta property="og:image" content="${escapeHtml(metadata.ogImage)}" />`);
  }

  return lines;
}

/** Emits the project README documenting the standalone frontend setup. */
export function generateRootReadme(appName: string): ProjectFile {
  const content = [
    `# ${appName}`,
    '',
    'A standalone React frontend synthesized by **apograph** — an industrial',
    'cleanroom reverse-engineering and code synthesis tool — from an approved',
    'plan and captured evidence (screenshots, a11y trees, design tokens).',
    '',
    '## Stack',
    '',
    `- React ${REACT_VERSION} + Vite`,
    '- React Router v7',
    `- Tailwind CSS ${TAILWIND_VERSION} (CSS-first config in src/index.css)`,
    '- lucide-react icons',
    '',
    '## Local Setup',
    '',
    '```bash',
    'pnpm install',
    'pnpm dev',
    '```',
    '',
    'The dev server runs on http://localhost:5173.',
    '',
    '## Build',
    '',
    '```bash',
    'pnpm build',
    '```',
    '',
    'Mirrored reference images live in `public/assets/`.',
    '',
  ].join('\n');

  return { path: 'README.md', content };
}

/** Emits the standalone frontend package.json with the fixed target stack. */
export function generateFrontendScaffold(
  appName: string,
  metadata?: RouteMetadata,
): ProjectFile[] {
  const packageJson = {
    name: appName,
    private: true,
    version: '0.1.0',
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'tsc --noEmit && vite build',
      preview: 'vite preview',
    },
    dependencies: {
      'lucide-react': LUCIDE_REACT_VERSION,
      react: REACT_VERSION,
      'react-dom': REACT_VERSION,
      'react-router': REACT_ROUTER_VERSION,
    },
    devDependencies: {
      '@tailwindcss/vite': TAILWIND_VERSION,
      '@types/react': '^19.2.0',
      '@types/react-dom': '^19.2.0',
      '@vitejs/plugin-react': '^4.6.0',
      tailwindcss: TAILWIND_VERSION,
      typescript: '^5.9.0',
      vite: '^7.1.0',
    },
    pnpm: {
      // Read by pnpm < 11. pnpm 11 moved this setting to pnpm-workspace.yaml
      // (also emitted below), but older pnpm users still honor this block.
      onlyBuiltDependencies: ['esbuild'],
    },
  };

  const viteConfig = [
    "import { defineConfig } from 'vite';",
    "import react from '@vitejs/plugin-react';",
    "import tailwindcss from '@tailwindcss/vite';",
    '',
    'export default defineConfig({',
    '  plugins: [react(), tailwindcss()],',
    "  server: { port: 5173, strictPort: false, host: '127.0.0.1' },",
    '});',
    '',
  ].join('\n');

  const indexHtml = [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    ...buildHeadLines(appName, metadata),
    '  </head>',
    '  <body>',
    '    <div id="root"></div>',
    '    <script type="module" src="/src/main.tsx"></script>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');

  const tsConfig = {
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      moduleResolution: 'bundler',
      jsx: 'react-jsx',
      // Compiler resilience: local AI models emit minor type quirks (e.g. a
      // Lucide icon component passed where ReactNode is expected). Strict
      // mode turns those into build-aborting TS2322 errors; the verifier's
      // auto-repair loop handles whatever remains.
      strict: false,
      noImplicitAny: false,
      // Local AI models frequently emit harmless unused imports
      // (e.g. `import { ReactNode } from 'react'`) — that must not break
      // the generated project's build.
      noUnusedLocals: false,
      noUnusedParameters: false,
      noFallthroughCasesInSwitch: true,
      noEmit: true,
      skipLibCheck: true,
      isolatedModules: true,
      useDefineForClassFields: true,
      // LLMs frequently emit `import { FormEvent } from 'react'` rather than
      // `import type`; verbatimModuleSyntax turns that quirk into TS1484 and
      // fails the whole build. Type-only elision below keeps such imports
      // harmless while isolatedModules stays enabled.
      verbatimModuleSyntax: false,
      types: ['vite/client'],
    },
    include: ['src'],
  };

  // pnpm 11 reads build-script approvals from pnpm-workspace.yaml (the
  // package.json `pnpm` field is no longer honored); without this file pnpm
  // blocks esbuild's postinstall and `vite build` fails.
  const pnpmWorkspace = [
    '# Generated by apograph — pnpm 11 reads build-script approvals here.',
    'allowBuilds:',
    '  esbuild: true',
    'onlyBuiltDependencies:',
    '  - esbuild',
    '',
  ].join('\n');

  return [
    { path: 'package.json', content: `${JSON.stringify(packageJson, null, 2)}\n` },
    { path: 'pnpm-workspace.yaml', content: pnpmWorkspace },
    { path: 'vite.config.ts', content: viteConfig },
    { path: 'index.html', content: indexHtml },
    { path: 'tsconfig.json', content: `${JSON.stringify(tsConfig, null, 2)}\n` },
  ];
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

/** Options for {@link emitProject}. */
export interface EmitOptions {
  /** Overwrite the output directory completely without prompting. */
  force?: boolean;
  /** Allow interactive prompts when the directory exists. Defaults to false. */
  interactive?: boolean;
  /** SEO / OpenGraph metadata populated into index.html <head>. */
  metadata?: RouteMetadata;
}

/** Outcome choice for an existing output directory. */
type ExistingDirAction = 'update' | 'overwrite' | 'abort';

/** Thrown when the user aborts emission at the overwrite guard. */
export class EmissionAbortedError extends Error {
  constructor(projectDir: string) {
    super(`Emission aborted: output directory ${projectDir} already exists.`);
  }
}

/** True when a directory exists and contains at least one entry. */
async function isNonEmptyDir(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolves what to do with an existing output directory:
 * - `force`: overwrite completely, no prompt.
 * - interactive: [1] Update/Resume (merge), [2] Overwrite completely,
 *   [3] Abort.
 * - non-interactive: safe merge (update) — generated files overwrite, but
 *   existing project files are never deleted.
 */
async function resolveExistingDirAction(
  projectDir: string,
  options: EmitOptions,
): Promise<ExistingDirAction> {
  if (options.force === true) return 'overwrite';

  if (options.interactive === true) {
    const choice = await p.select({
      message: `Directory ${projectDir} exists:`,
      options: [
        {
          value: 'update' as const,
          label: '1. Update/Resume',
          hint: 'overwrite generated files, keep everything else',
        },
        {
          value: 'overwrite' as const,
          label: '2. Overwrite completely',
          hint: 'delete the directory and regenerate from scratch',
        },
        {
          value: 'abort' as const,
          label: '3. Abort',
          hint: 'stop without writing anything',
        },
      ],
    });

    if (p.isCancel(choice)) {
      throw new EmissionAbortedError(projectDir);
    }
    return choice;
  }

  return 'update';
}

/**
 * Assembles the frontend scaffold plus the synthesized files (synthesized
 * entries win on path collisions) and writes the full standalone project
 * tree under `targetDir`. Returns the list of written file paths relative to
 * the project directory, plus the absolute project directory.
 */
export async function emitProject(
  projectFiles: ProjectFile[],
  targetDir: string,
  appName: string = 'apograph-app',
  options: EmitOptions = {},
): Promise<{ writtenFiles: string[]; projectDir: string }> {
  const projectDir = resolve(targetDir);
  try {
    const rootInfo = await lstat(projectDir);
    if (rootInfo.isSymbolicLink()) throw new Error(`Output directory must not be a symlink: ${projectDir}`);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }

  // Overwrite guard for existing output directories.
  if (await isNonEmptyDir(projectDir)) {
    const action = await resolveExistingDirAction(projectDir, options);
    if (action === 'abort') {
      throw new EmissionAbortedError(projectDir);
    }
    if (action === 'overwrite') {
      await rm(projectDir, { recursive: true, force: true });
    }
    // 'update': fall through — merge semantics below never delete files.
  }

  const boilerplate: ProjectFile[] = [
    generateRootReadme(appName),
    ...generateFrontendScaffold(appName, options.metadata),
  ];

  // Merge by path; later entries (synthesized files) take precedence.
  const merged = new Map<string, ProjectFile>();
  for (const file of boilerplate) {
    merged.set(file.path, file);
  }
  for (const file of projectFiles) {
    merged.set(file.path, file);
  }

  const writtenFiles: string[] = [];

  for (const file of merged.values()) {
    const safePath = assertSafeRelativePath(file.path);
    const filePath = resolveContainedPath(projectDir, safePath);
    await mkdir(dirname(filePath), { recursive: true });
    await assertNoSymlinkComponents(projectDir, filePath);
    await writeFile(filePath, file.content, 'utf8');
    writtenFiles.push(safePath);
  }

  return { writtenFiles, projectDir };
}
