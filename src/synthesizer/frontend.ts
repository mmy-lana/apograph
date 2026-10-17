/**
 * apograph — Frontend synthesis (Layer 5: Orchestration).
 *
 * Serializes harvested DOM snapshots and unpacked bundles into token-efficient
 * prompts for LLM code generation, and deterministically emits the Tailwind
 * config from extracted design tokens (zero AI tokens burned on that file).
 */

import type { DOMSnapshot, DecompiledBundle, ProjectFile, DesignTokens, A11yNode } from '../types.js';
import { generateStructuredFiles } from './llm.js';

/** Max A11y tree depth serialized into prompts (structural semantics, low tokens). */
const MAX_A11Y_DEPTH = 6;

// ---------------------------------------------------------------------------
// Prompt serialization
// ---------------------------------------------------------------------------

/**
 * Serializes design tokens into a concise multi-line summary suitable for
 * prompt embedding.
 */
export function formatDesignTokensForPrompt(tokens: DOMSnapshot['tokens']): string {
  const colorLines = Object.entries(tokens.colors).map(
    ([name, value]) => `  ${name}: ${value}`,
  );
  const sections: string[] = [];

  sections.push(
    colorLines.length > 0 ? `Colors:\n${colorLines.join('\n')}` : 'Colors: (none)',
  );

  sections.push(
    `Fonts: ${tokens.fonts.length > 0 ? tokens.fonts.join(', ') : '(none)'}`,
  );

  sections.push(
    `Spacing: ${tokens.spacing.length > 0 ? tokens.spacing.join(', ') : '(none)'}`,
  );

  sections.push(
    `Radii: ${tokens.radii.length > 0 ? tokens.radii.join(', ') : '(none)'}`,
  );

  return sections.join('\n');
}

/**
 * Recursively formats the A11y tree into an indented text representation of
 * `role "name" = value` lines. Depth is capped at {@link MAX_A11Y_DEPTH} to
 * protect prompt context while preserving structural semantics.
 */
export function formatA11yTreeForPrompt(
  node: DOMSnapshot['a11yTree'],
  depth: number = 0,
): string {
  const indent = '  '.repeat(depth);

  const label = node.name !== undefined ? ` "${node.name}"` : '';
  const value = node.value !== undefined ? ` = ${node.value}` : '';

  const lines = [`${indent}${node.role}${label}${value}`];

  if (depth < MAX_A11Y_DEPTH) {
    for (const child of node.children ?? []) {
      lines.push(formatA11yTreeForPrompt(child, depth + 1));
    }
  }

  return lines.join('\n');
}

/**
 * Lists recovered module paths and exported component names from unpacked
 * bundles so the LLM reuses authentic names from the original app.
 */
export function summarizeBundleComponents(bundles: DecompiledBundle[]): string {
  const lines: string[] = [];

  for (const bundle of bundles) {
    if (bundle.modules.length === 0) continue;

    lines.push(`${bundle.bundleName} (${bundle.modules.length} modules):`);

    for (const module of bundle.modules) {
      const componentExports = module.exports.filter((name) =>
        /^[A-Z][A-Za-z0-9_]*$/.test(name) || /^default:[A-Z]/.test(name),
      );

      const exportSummary =
        componentExports.length > 0 ? componentExports.join(', ') : '(no components)';
      lines.push(`  ${module.path}: ${exportSummary}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : '(no unpacked bundles)';
}

// ---------------------------------------------------------------------------
// Deterministic Tailwind config
// ---------------------------------------------------------------------------

/** Picks a deterministic, Tailwind-safe color name for a CSS value. */
function tailwindColorName(value: string): string {
  if (value.startsWith('#')) {
    return `c${value.replace('#', '').toLowerCase()}`;
  }
  const slug = value.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return slug.length > 0 ? slug : 'default';
}

/** True when a fonts-array value is a font size rather than a family name. */
const FONT_SIZE_RE = /^\d+(\.\d+)?(px|rem|em|pt|%)$/;

/** Extracts the first font family name from a raw font-family value. */
function tailwindFontFamily(value: string): string {
  const first = value.split(',')[0] ?? value;
  return first.trim().replace(/['"]/g, '');
}

/**
 * Deterministically generates a `tailwind.config.js` source string from the
 * extracted design tokens — colors and font families are mapped directly,
 * no LLM tokens are spent on this file.
 */
export function generateTailwindConfig(tokens: DOMSnapshot['tokens']): string {
  const colors: Record<string, string> = {};
  for (const value of Object.values(tokens.colors)) {
    colors[tailwindColorName(value)] = value;
  }

  const fontFamily: Record<string, string[]> = {};
  let fontIndex = 0;
  for (const font of tokens.fonts) {
    if (FONT_SIZE_RE.test(font)) continue;
    const family = tailwindFontFamily(font);
    if (family.length === 0 || FONT_SIZE_RE.test(family)) continue;
    const slot = fontIndex === 0 ? 'sans' : `sans-${fontIndex}`;
    fontFamily[slot] = [family];
    fontIndex += 1;
  }

  const spacing: Record<string, string> = {};
  tokens.spacing.forEach((value, index) => {
    spacing[`apograph-${index}`] = value;
  });

  const borderRadius: Record<string, string> = {};
  tokens.radii.forEach((value, index) => {
    borderRadius[`apograph-${index}`] = value;
  });

  return [
    '/** tailwind.config.js — generated deterministically by apograph from harvested design tokens. */',
    `module.exports = ${JSON.stringify(
      {
        content: ['./index.html', './src/**/*.{ts,tsx}'],
        theme: {
          extend: {
            ...(Object.keys(colors).length > 0 ? { colors } : {}),
            ...(Object.keys(fontFamily).length > 0 ? { fontFamily } : {}),
            ...(Object.keys(spacing).length > 0 ? { spacing } : {}),
            ...(Object.keys(borderRadius).length > 0 ? { borderRadius } : {}),
          },
        },
        plugins: [],
      },
      null,
      2,
    )};`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

/** System prompt guiding the frontend synthesis model. */
const SYSTEM_GUIDELINES = [
  'You are an expert frontend engineer synthesizing a React application from a cleanroom harvest.',
  'Rules:',
  '1. Use React 19 with modern functional components and hooks only — no class components.',
  '2. Style strictly with Tailwind CSS utility classes — no inline style objects, no separate CSS files.',
  '3. Map the harvested accessibility tree structure to semantic HTML (roles -> elements, names -> labels/text).',
  '4. Reuse authentic component, module, and export names recovered from the unpacked bundles where applicable.',
  '5. Apply the extracted design tokens (colors, fonts, spacing, radii) through the provided Tailwind theme values.',
  '6. Emit these files exactly:',
  '   - src/App.tsx — main router/view switch over the captured routes.',
  '   - src/components/*.tsx — semantic page, card, and list components.',
  '   - src/index.css — containing exactly: @tailwind base; @tailwind components; @tailwind utilities;',
  '7. Every file must be complete and compile-ready — no placeholders, no TODOs, no truncation.',
  '- When rendering icons from lucide-react in maps, lists, or components, store the component reference and render as `<item.icon className="..." />`, or store JSX elements directly `icon: <Shield className="..." />`. Never assign string names and component references to the same property.',
].join('\n');

/**
 * Synthesizes the frontend project files from captured DOM snapshots and
 * unpacked bundles: prompts the LLM for React components, then merges in the
 * deterministically generated `tailwind.config.js`.
 */
export async function synthesizeFrontend(
  snapshots: DOMSnapshot[],
  bundles: DecompiledBundle[],
): Promise<ProjectFile[]> {
  const routeSections = snapshots.map((snapshot) => {
    return [
      `## Route: ${snapshot.route}`,
      '',
      'Accessibility tree (role "name" = value):',
      formatA11yTreeForPrompt(snapshot.a11yTree),
    ].join('\n');
  });

  const tokenSections = snapshots.map((snapshot) => {
    return [
      `## Route: ${snapshot.route}`,
      '',
      formatDesignTokensForPrompt(snapshot.tokens),
    ].join('\n');
  });

  const prompt = [
    'Synthesize a React frontend application from the following cleanroom harvest.',
    '',
    '# Captured Routes & Accessibility Trees',
    routeSections.length > 0 ? routeSections.join('\n\n') : '(no routes captured)',
    '',
    '# Extracted Design Tokens',
    tokenSections.length > 0 ? tokenSections.join('\n\n') : '(no tokens extracted)',
    '',
    '# Recovered Bundle Components (reuse authentic names)',
    summarizeBundleComponents(bundles),
    '',
    'Generate src/App.tsx, the src/components/*.tsx files, and src/index.css.',
    'Do NOT generate tailwind.config.js — it is provided deterministically.',
  ].join('\n');

  const generatedFiles = await generateStructuredFiles(prompt, SYSTEM_GUIDELINES);

  const tailwindConfig: ProjectFile = {
    path: 'tailwind.config.js',
    content: generateTailwindConfig(
      snapshots[0]?.tokens ?? emptyTokens(),
    ),
  };

  return [...generatedFiles.filter((file) => file.path !== 'tailwind.config.js'), tailwindConfig];
}

/** Empty design token set used when no snapshots were captured. */
function emptyTokens(): DesignTokens {
  return { colors: {}, fonts: [], spacing: [], radii: [] };
}

// Re-export the a11y node type for consumers building on this module.
export type { A11yNode };
