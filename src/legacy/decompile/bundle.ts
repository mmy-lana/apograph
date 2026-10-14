/**
 * apograph — Bundle decompilation (Layer 2: Reconstruction).
 *
 * Runs webcrack over harvested script sources and maps the result into the
 * canonical `DecompiledBundle` / `UnpackedModule` shapes.
 */

import { webcrack } from 'webcrack';
import type { UnpackedModule, DecompiledBundle } from '../../types.js';

/**
 * Decompile a single bundle source into the canonical shape.
 *
 * When webcrack detects a module bundle (webpack/browserify), every module is
 * mapped individually; otherwise the de-obfuscated code is returned as a
 * single module named after the bundle.
 */
export async function decompileBundle(
  bundleSource: string,
  bundleName: string,
): Promise<DecompiledBundle> {
  const result = await webcrack(bundleSource);

  if (result.bundle) {
    const modules: UnpackedModule[] = [];

    for (const [id, module] of result.bundle.modules) {
      const code = module.code;
      modules.push({
        path: module.path ? ensureJsExtension(module.path) : `module-${id}.js`,
        rawCode: code,
        astType: 'module',
        exports: extractExports(code),
      });
    }

    return { bundleName, modules };
  }

  return {
    bundleName,
    modules: [
      {
        path: `${bundleName}.js`,
        rawCode: result.code,
        astType: 'program',
        exports: extractExports(result.code),
      },
    ],
  };
}

/**
 * Decompile every harvested script source, assigning sequential bundle names.
 * Each script is decompiled independently and defensively: a malformed script
 * falls back to a raw-source module instead of crashing the pipeline.
 */
export async function harvestAndDecompileScripts(
  scriptSources: string[],
): Promise<DecompiledBundle[]> {
  const bundles: DecompiledBundle[] = [];

  for (const [index, source] of scriptSources.entries()) {
    const bundleName = `bundle-${index}`;

    try {
      bundles.push(await decompileBundle(source, bundleName));
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      console.warn(
        `[apograph] webcrack failed on ${bundleName} (${reason}); ` +
          'falling back to raw source.',
      );

      bundles.push({
        bundleName,
        modules: [
          {
            path: `${bundleName}.js`,
            rawCode: source,
            astType: 'raw',
            exports: [],
          },
        ],
      });
    }
  }

  return bundles;
}

// ---------------------------------------------------------------------------
// Export extraction
// ---------------------------------------------------------------------------

/**
 * Best-effort extraction of exported identifier names from JavaScript
 * source text. Covers the common export forms:
 *
 *   export default x
 *   export { a, b as c }
 *   export const/function/class/let x
 */
function extractExports(code: string): string[] {
  const names = new Set<string>();

  // export default <name>;
  const defaultMatch = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?/.exec(code);
  if (defaultMatch?.[1]) names.add(`default:${defaultMatch[1]}`);

  // export { a, b as c } — multiple occurrences.
  for (const match of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    const clause = match[1] ?? '';
    for (const specifier of clause.split(',')) {
      const parts = specifier.trim().split(/\s+as\s+/);
      const local = parts[0]?.trim();
      if (local) names.add(local);
    }
  }

  // export const|let|var|function|class <name>
  for (const match of code.matchAll(
    /\bexport\s+(?:async\s+)?(?:const|let|var|function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    if (match[1]) names.add(match[1]);
  }

  return [...names];
}

/** Ensures a module path ends in a .js extension. */
function ensureJsExtension(path: string): string {
  return path.endsWith('.js') ? path : `${path}.js`;
}
