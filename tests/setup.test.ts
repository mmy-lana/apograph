/**
 * Unit tests for the setup command helpers (DSH-01, CLIENT-01).
 *
 * Runs on native node:test with no additional dependencies (D5). File-based
 * tests operate on temporary directories only.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  dshEntryDefinition,
  renderDshPrintBlock,
  renderMcpServersPrintBlock,
  resolveDshHome,
  dshPresetPath,
  runDshSetup,
  writeMcpServersConfig,
  normalizeClientKey,
} from '../dist/commands/setup.js';

const SERVER = { command: 'npx', args: ['-y', 'apograph-agents', 'mcp'] };

/** Creates one temp workspace directory per test. */
async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'apograph-setup-test-'));
}

describe('normalizeClientKey', () => {
  test('accepts dsh and custom (case-insensitive)', () => {
    assert.equal(normalizeClientKey('dsh'), 'dsh');
    assert.equal(normalizeClientKey('DSH'), 'dsh');
    assert.equal(normalizeClientKey('custom'), 'custom');
    assert.equal(normalizeClientKey('deepseek-harness'), 'dsh');
  });

  test('rejects unknown client names', () => {
    assert.equal(normalizeClientKey('bogus'), null);
    assert.equal(normalizeClientKey(''), null);
  });

  test('preserves the five existing clients and aliases', () => {
    assert.equal(normalizeClientKey('claude-desktop'), 'claude-desktop');
    assert.equal(normalizeClientKey('claude'), 'claude-desktop');
    assert.equal(normalizeClientKey('cursor'), 'cursor');
    assert.equal(normalizeClientKey('claude-code'), 'claude-code');
    assert.equal(normalizeClientKey('windsurf'), 'windsurf');
    assert.equal(normalizeClientKey('opencode'), 'opencode');
  });
});

describe('DSH entry generation', () => {
  test('dshEntryDefinition registers stdio transport via the package name', () => {
    const entry = dshEntryDefinition();
    assert.equal(entry.id, 'mcp-apograph');
    assert.equal(entry.name, '@deepseek-ai/dsh-mcp-client');
    assert.equal(entry.config.serverName, 'apograph');
    assert.equal(entry.config.transport, 'stdio');
    assert.equal(entry.config.command, 'npx');
    assert.deepEqual(entry.config.args, ['-y', 'apograph-agents', 'mcp']);
  });

  test('renderDshPrintBlock emits copy-pasteable JSON containing the entry', () => {
    const block = renderDshPrintBlock();
    const parsed = JSON.parse(block);
    assert.deepEqual(parsed, [dshEntryDefinition()]);
    assert.ok(block.includes('mcp-apograph'));
  });

  test('resolveDshHome prefers $DSH_HOME, falls back to ~/.dsh when present, else null', async () => {
    assert.equal(resolveDshHome({ DSH_HOME: '/tmp/fake-dsh' }, '/nonexistent-home'), '/tmp/fake-dsh');
    assert.equal(resolveDshHome({ DSH_HOME: '' }, '/nonexistent-home'), null);
    const home = await tempDir();
    try {
      // No ~/.dsh directory yet → null.
      assert.equal(resolveDshHome({}, home), null);
      // ~/.dsh directory exists → used as the home.
      await mkdir(join(home, '.dsh'), { recursive: true });
      assert.equal(resolveDshHome({}, home), join(home, '.dsh'));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('runDshSetup', () => {
  test('print-fallback when no DSH home is locatable', async () => {
    const lines: string[] = [];
    const errs: string[] = [];
    const result = await runDshSetup(null, (m) => lines.push(m), (m) => errs.push(m));
    assert.equal(result, 'printed');
    assert.ok(errs.some((m) => m.includes('No DSH home found')));
    assert.ok(lines.some((m) => m.includes('"mcp-apograph"')));
    assert.ok(lines.some((m) => m.includes('@deepseek-ai/dsh-mcp-client')));
  });

  test('creates a fresh agent preset under the DSH home', async () => {
    const home = await tempDir();
    try {
      const logs: string[] = [];
      const result = await runDshSetup(home, (m) => logs.push(m), () => {});
      assert.equal(result, 'created');
      const preset = dshPresetPath(home);
      assert.ok(existsSync(preset));
      const body = await readFile(preset, 'utf8');
      assert.ok(body.includes('id: mcp-apograph'));
      assert.ok(body.includes("@deepseek-ai/dsh-mcp-client'"));
      assert.ok(body.includes("transport: stdio"));
      assert.ok(logs.some((m) => m.includes(preset)));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('idempotent: second run is a no-op', async () => {
    const home = await tempDir();
    try {
      assert.equal(await runDshSetup(home, () => {}, () => {}), 'created');
      const before = await readFile(dshPresetPath(home), 'utf8');
      assert.equal(await runDshSetup(home, () => {}, () => {}), 'unchanged');
      assert.equal(await readFile(dshPresetPath(home), 'utf8'), before);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('existing preset without the entry: prints block, never rewrites the file', async () => {
    const home = await tempDir();
    try {
      const preset = dshPresetPath(home);
      await mkdir(dirname(preset), { recursive: true });
      await writeFile(preset, '# my existing preset rows\n- id: mcp-other\n', 'utf8');
      const logs: string[] = [];
      const result = await runDshSetup(home, (m) => logs.push(m), () => {});
      assert.equal(result, 'printed');
      assert.ok(logs.some((m) => m.includes('does not contain')));
      assert.equal(await readFile(preset, 'utf8'), '# my existing preset rows\n- id: mcp-other\n');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('writeMcpServersConfig (generic custom client)', () => {
  test('creates a new config file when missing', async () => {
    const dir = await tempDir();
    try {
      const file = join(dir, 'mcp.json');
      const logs: string[] = [];
      const result = await writeMcpServersConfig(file, SERVER, (m) => logs.push(m));
      assert.equal(result, 'created');
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      assert.deepEqual(parsed.mcpServers.apograph, { command: 'npx', args: ['-y', 'apograph-agents', 'mcp'] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('merges into an existing config, preserving unrelated keys', async () => {
    const dir = await tempDir();
    try {
      const file = join(dir, 'mcp.json');
      await writeFile(
        file,
        JSON.stringify({ model: 'x', mcpServers: { other: { command: 'foo', args: [] } } }),
        'utf8',
      );
      const result = await writeMcpServersConfig(file, SERVER, () => {});
      assert.equal(result, 'updated');
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(parsed.model, 'x');
      assert.deepEqual(parsed.mcpServers.other, { command: 'foo', args: [] });
      assert.deepEqual(parsed.mcpServers.apograph, { command: SERVER.command, args: SERVER.args });
      // Exactly one backup file was written.
      const files = (await readdir(dir)).filter((f) => f !== 'mcp.json');
      assert.equal(files.length, 1);
      assert.ok(files[0].includes('.backup-'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('idempotent: identical entry is a no-op with no new backup', async () => {
    const dir = await tempDir();
    try {
      const file = join(dir, 'mcp.json');
      await writeMcpServersConfig(file, SERVER, () => {});
      const before = await readFile(file, 'utf8');
      const result = await writeMcpServersConfig(file, SERVER, () => {});
      assert.equal(result, 'unchanged');
      assert.equal(await readFile(file, 'utf8'), before);
      const files = (await readdir(dir)).filter((f) => f !== 'mcp.json');
      assert.equal(files.length, 0, 'no backup should be written for a no-op');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('aborts without modification on invalid JSON', async () => {
    const dir = await tempDir();
    try {
      const file = join(dir, 'mcp.json');
      const broken = '{ not valid json !!';
      await writeFile(file, broken, 'utf8');
      await assert.rejects(() => writeMcpServersConfig(file, SERVER, () => {}), /not valid JSON/);
      assert.equal(await readFile(file, 'utf8'), broken, 'file must be untouched');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('renderMcpServersPrintBlock', () => {
  test('emits the standard mcpServers JSON shape', () => {
    const parsed = JSON.parse(renderMcpServersPrintBlock());
    assert.deepEqual(parsed, {
      mcpServers: { apograph: { command: 'npx', args: ['-y', 'apograph-agents', 'mcp'] } },
    });
  });
});
