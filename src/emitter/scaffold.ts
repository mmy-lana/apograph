/**
 * apograph — Project scaffolding & emission (Layer 5: Output, Phase 4).
 *
 * Emits a pure, standalone multi-page frontend project (React 19.3 + Vite +
 * React Router v7 + Tailwind CSS 4.3 + lucide-react) — zero backend or
 * SQLite generation. The scaffold provides the deterministic root files
 * (package.json, vite.config.ts, index.html, tsconfig.json, README) around
 * the modular synthesis output; synthesized files win on path collisions.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ProjectFile } from '../types.js';

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
export function generateFrontendScaffold(appName: string): ProjectFile[] {
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
  };

  const viteConfig = [
    "import { defineConfig } from 'vite';",
    "import react from '@vitejs/plugin-react';",
    "import tailwindcss from '@tailwindcss/vite';",
    '',
    'export default defineConfig({',
    '  plugins: [react(), tailwindcss()],',
    "  server: { port: 5173 },",
    '});',
    '',
  ].join('\n');

  const indexHtml = [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `    <title>${appName}</title>`,
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
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noFallthroughCasesInSwitch: true,
      noEmit: true,
      skipLibCheck: true,
      isolatedModules: true,
      useDefineForClassFields: true,
      verbatimModuleSyntax: true,
      types: ['vite/client'],
    },
    include: ['src'],
  };

  return [
    { path: 'package.json', content: `${JSON.stringify(packageJson, null, 2)}\n` },
    { path: 'vite.config.ts', content: viteConfig },
    { path: 'index.html', content: indexHtml },
    { path: 'tsconfig.json', content: `${JSON.stringify(tsConfig, null, 2)}\n` },
  ];
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

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
): Promise<{ writtenFiles: string[]; projectDir: string }> {
  const projectDir = resolve(targetDir);

  const boilerplate: ProjectFile[] = [
    generateRootReadme(appName),
    ...generateFrontendScaffold(appName),
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
    const filePath = join(projectDir, file.path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content, 'utf8');
    writtenFiles.push(file.path);
  }

  return { writtenFiles, projectDir };
}
