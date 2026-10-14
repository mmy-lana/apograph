/**
 * apograph — Environment diagnostics (`apograph doctor`).
 *
 * Checks Node.js runtime, headless Chromium availability (Playwright
 * launch probe), active LLM connectivity (1-token probe through the resolved
 * model), and local Ollama status, printing a [PASS]/[WARN] checklist with
 * exact fix commands.
 */

import { versions } from 'node:process';
import { generateText } from 'ai';
import { chromium } from 'playwright';
import { getModel, resolveProviderName } from '../config/models.js';

const OLLAMA_TAGS_URL = 'http://localhost:11434/api/tags';
const PROBE_TIMEOUT_MS = 3_000;
const MIN_NODE_MAJOR = 20;

/** One diagnostic outcome. */
interface CheckResult {
  label: string;
  pass: boolean;
  detail: string;
  fix: string | null;
}

/** Probes a URL and returns its JSON object body, or null on failure. */
async function probeJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Checks the Node.js runtime major version. */
function checkNodeVersion(): CheckResult {
  const major = Number.parseInt(versions.node.split('.')[0] ?? '0', 10);
  return {
    label: `Node.js >= ${MIN_NODE_MAJOR}`,
    pass: major >= MIN_NODE_MAJOR,
    detail: `found v${versions.node}`,
    fix: major >= MIN_NODE_MAJOR ? null : 'Install Node 20+ from https://nodejs.org or run `nvm install 20 && nvm use 20`',
  };
}

/** Checks headless Chromium availability by launching a probe instance. */
async function checkChromium(): Promise<CheckResult> {
  try {
    const browser = await chromium.launch({ headless: true });
    const version = browser.version();
    await browser.close();

    return {
      label: 'Headless Chromium (Playwright)',
      pass: true,
      detail: version,
      fix: null,
    };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      label: 'Headless Chromium (Playwright)',
      pass: false,
      detail: reason,
      fix: 'Install the Playwright Chromium build: `pnpm exec playwright install chromium`',
    };
  }
}

/** Checks the resolved LLM with a 1-token generation probe. */
async function checkLlm(): Promise<CheckResult> {
  const provider = resolveProviderName();

  try {
    const model = getModel();
    const result = await generateText({
      model,
      prompt: 'ping',
      maxTokens: 1,
    });
    return {
      label: `LLM connectivity (${provider})`,
      pass: true,
      detail: `probe returned ${result.text.length > 0 ? 'a token' : 'an empty completion'}`,
      fix: null,
    };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      label: `LLM connectivity (${provider})`,
      pass: false,
      detail: reason,
      fix:
        provider === 'local'
          ? 'Start Ollama (`ollama serve`) and pull the fallback model (`ollama pull apograph-qwen35:9b-8k`), or export OPENAI_API_KEY / ANTHROPIC_API_KEY.'
          : 'Check your API key and network access for the configured provider, or point APOGRAPH_BASE_URL / APOGRAPH_API_KEY at a reachable gateway.',
    };
  }
}

/** Checks local Ollama status via its tags API. */
async function checkOllama(): Promise<CheckResult> {
  const body = await probeJson(OLLAMA_TAGS_URL);

  if (body) {
    const models = Array.isArray(body.models) ? body.models : [];
    return {
      label: 'Ollama (localhost:11434)',
      pass: true,
      detail: `${models.length} model(s) available`,
      fix: null,
    };
  }

  return {
    label: 'Ollama (localhost:11434)',
    pass: false,
    detail: 'no response from /api/tags',
    fix:
      'Optional local fallback — install from https://ollama.com, then run `ollama serve` and `ollama pull apograph-qwen35:9b-8k`.',
  };
}

/** Runs all diagnostics and prints the formatted checklist. */
export async function runDoctor(): Promise<void> {
  console.log('apograph doctor — environment diagnostics\n');

  const checks: CheckResult[] = [
    checkNodeVersion(),
    await checkChromium(),
    await checkLlm(),
    await checkOllama(),
  ];

  for (const check of checks) {
    const marker = check.pass ? '[PASS]' : '[WARN]';
    console.log(`${marker} ${check.label} — ${check.detail}`);
    if (!check.pass && check.fix) {
      const indented = check.fix
        .split('\n')
        .map((line) => `         ${line}`)
        .join('\n');
      console.log(`         fix: ${indented.trim()}`);
    }
  }

  const passed = checks.filter((check) => check.pass).length;
  console.log(`\n${passed}/${checks.length} checks passed.`);

  if (passed < checks.length) {
    console.log('Resolve the [WARN] items above (fixes included) and re-run `apograph doctor`.');
  }
}
