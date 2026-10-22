import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeRelativePath, resolveContainedPath } from '../dist/utils/fs-safe.js';
import { validateNetworkUrl } from '../dist/crawler/network-policy.js';
import { runTier1Build, verifyBuild } from '../dist/verifier/engine.js';
import { loadEvidenceManifest, uniqueComponentNames, createPlanFromEvidence } from '../dist/plan/generator.js';
import { recrawlRoute } from '../dist/plan/evidenceGate.js';
import { ApographPlanSchema } from '../dist/plan/schema.js';
import { resolveCloneOutputDir, resolveCrawlEvidenceDir } from '../dist/mcp/server.js';
import type { EvidenceManifest } from '../dist/types.js';
import type { CommandResult, Tier1Deps } from '../dist/verifier/engine.js';

test('security > filesystem paths reject traversal and absolute paths', () => {
  assert.equal(resolveContainedPath('/tmp/apograph-root', 'src/App.tsx'), '/tmp/apograph-root/src/App.tsx');
  for (const value of ['../outside', 'src/../outside', '/etc/passwd', '..\\outside', '']) {
    assert.throws(() => assertSafeRelativePath(value));
  }
  assert.throws(() => resolveContainedPath('/tmp/apograph-root', '../sibling'));
});

test('security > network policy rejects restricted destinations', async () => {
  for (const url of [
    'http://127.0.0.1:8080/',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://localhost/',
    'http://metadata.google.internal/',
  ]) {
    await assert.rejects(validateNetworkUrl(url, { resolve: async () => [{ address: '127.0.0.1', family: 4 }] }));
  }
});

test('security > network policy rejects DNS results that resolve privately', async () => {
  await assert.rejects(
    validateNetworkUrl('https://public.example/', {
      resolve: async () => [{ address: '192.168.1.20', family: 4 }],
    }),
  );
});

test('security > MCP workspace paths reject traversal', () => {
  assert.equal(resolveCrawlEvidenceDir(), join(process.cwd(), '.apograph', 'evidence'));
  assert.throws(() => resolveCloneOutputDir('example', '../outside'));
  assert.throws(() => resolveCloneOutputDir('../outside'));
  assert.throws(() => resolveCloneOutputDir('example', 'workspace/../../outside'));
});

test('security > recrawl rejects loopback destinations before browser navigation', async () => {
  const manifest = {
    targetUrl: 'http://127.0.0.1:8080/',
    crawledAt: new Date().toISOString(),
    stats: {
      pagesCrawled: 1,
      linksDiscovered: 0,
      assetsDownloaded: 0,
      assetsFailed: 0,
      externalAssets: 0,
      durationMs: 0,
    },
    routes: [{
      url: 'http://127.0.0.1:8080/private',
      path: '/private',
      title: 'Private',
      desktopScreenshot: null,
      mobileScreenshot: null,
      a11yTree: { role: 'document', name: '', children: [] },
      tokens: { colors: {}, fonts: [], spacing: [], radii: [] },
    }],
    assets: [],
    diagnostics: {
      skippedUrls: [],
      failedNavigations: [],
      uncapturedResources: [],
      redirectAliases: [],
    },
  } satisfies EvidenceManifest;

  await assert.rejects(
    recrawlRoute(manifest, 1, '/tmp/apograph-evidence'),
    /Restricted network destination/i,
  );
});

test('security > generated verification fails closed without explicit unsafe opt-in', async () => {
  const previous = process.env.APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION;
  delete process.env.APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION;
  try {
    const result = await verifyBuild('/tmp/nonexistent-apograph-project');
    assert.equal(result.success, false);
    assert.match(result.errors.join(' '), /disabled by default/i);
  } finally {
    if (previous === undefined) delete process.env.APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION;
    else process.env.APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION = previous;
  }
});

test('security > malformed evidence manifests are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apograph-manifest-'));
  try {
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ routes: [], targetUrl: 'not-a-url' }));
    await assert.rejects(loadEvidenceManifest(root), /Invalid apograph evidence manifest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('security > plans reject duplicate route and unsafe component identifiers', () => {
  const base = {
    targetUrl: 'https://example.com', appName: 'example', stack: 'react-vite-tailwind', version: 1,
    approved: false, designSystem: { colors: {}, fonts: [], spacing: [], radii: [] }, assumptions: [], unknowns: [],
  } as const;
  const route = { path: '/', title: 'Home', componentName: 'HomePage', included: true, inferredInteractions: ['none'] as const };
  assert.throws(() => ApographPlanSchema.parse({ ...base, routes: [route, route] }));
  assert.throws(() => ApographPlanSchema.parse({ ...base, routes: [{ ...route, componentName: '../Escape' }] }));
});

test('security > colliding route paths derive unique component names', () => {
  // `/` and `/home` both derive `HomePage` — dedupe must keep them distinct,
  // deterministic, and schema-safe (`...Page` suffix preserved).
  const names = uniqueComponentNames(['/', '/home', '/pricing', '/pricing/']);
  assert.deepEqual(names, ['HomePage', 'Home2Page', 'PricingPage', 'Pricing2Page']);
  assert.equal(new Set(names).size, names.length, 'names must be unique');
  for (const name of names) assert.match(name, /^[A-Z][A-Za-z0-9]*Page$/, 'schema-safe identifiers');

  // The derived plan passes schema validation end to end.
  const manifest = {
    targetUrl: 'https://example.com',
    crawledAt: new Date().toISOString(),
    stats: { pagesCrawled: 2, linksDiscovered: 2, assetsDownloaded: 0, assetsFailed: 0, externalAssets: 0, durationMs: 1 },
    routes: [
      { url: 'https://example.com/', path: '/', title: 'Home', desktopScreenshot: null, mobileScreenshot: null, a11yTree: { role: 'root' }, tokens: { colors: {}, fonts: [], spacing: [], radii: [] } },
      { url: 'https://example.com/home', path: '/home', title: 'Home', desktopScreenshot: null, mobileScreenshot: null, a11yTree: { role: 'root' }, tokens: { colors: {}, fonts: [], spacing: [], radii: [] } },
    ],
    assets: [],
    diagnostics: { skippedUrls: [], failedNavigations: [], uncapturedResources: [], redirectAliases: [] },
  } as unknown as Parameters<typeof createPlanFromEvidence>[0];
  const plan = createPlanFromEvidence(manifest);
  assert.deepEqual(plan.routes.map((route) => route.componentName), ['HomePage', 'Home2Page']);
  ApographPlanSchema.parse(plan);
});

test('security > verifier treats residual type errors as failed build', async () => {
  const previous = process.env.APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION;
  process.env.APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION = '1';
  const root = await mkdtemp(join(tmpdir(), 'apograph-security-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'src', 'App.tsx'), 'export {}');
  const deps: Tier1Deps = {
    run: async (_command, args): Promise<CommandResult> =>
      args.includes('tsc')
        ? { ok: false, output: 'src/App.tsx(1,1): error TS2322: bad' }
        : { ok: true, output: '' },
    repairFile: async () => 'export {}',
  };
  try {
    const result = await runTier1Build(root, deps, 0);
    assert.equal(result.vitePassed, true);
    assert.equal(result.tscPassed, false);
    assert.equal(result.success, false);
  } finally {
    if (previous === undefined) delete process.env.APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION;
    else process.env.APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION = previous;
    await rm(root, { recursive: true, force: true });
  }
});
