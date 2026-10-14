# Reference Spec: Playwright CDP Attach & Capture

**Purpose (Layer 1 — Capture):** Attach to a running Chrome instance over the Chrome
DevTools Protocol, harvest network traffic (requests/responses), and snapshot the
accessibility tree. This spec is the canonical minimal shape for the capture engine;
no scraping logic lives here yet.

## Minimal Snippet

```ts
import { chromium } from 'playwright';

// Chrome must be launched with --remote-debugging-port=9222
const browser = await chromium.connectOverCDP('http://localhost:9222');
const context = browser.contexts()[0]!;
const page = context.pages()[0] ?? (await context.newPage());

const captured: Array<{ url: string; status: number; body: string | null }> = [];

page.on('response', async (response) => {
  const body = await response.text().catch(() => null);
  captured.push({
    url: response.url(),
    status: response.status(),
    body,
  });
});

await page.goto('https://example.com');

// Accessibility tree snapshot (structured roles/names, no pixel scraping)
const a11ySnapshot = await page.accessibility.snapshot();
console.log(JSON.stringify(a11ySnapshot, null, 2));

await browser.close();
```

## Contract Notes

- `chromium.connectOverCDP('http://localhost:9222')` attaches to an *existing*
  browser session (preserves logged-in state) rather than launching a fresh one.
- `page.on('response')` is the primary request/response harvest hook; bodies must
  be read eagerly inside the handler before navigation invalidates them.
- `page.accessibility.snapshot()` returns an `AxNode` tree (`role`, `name`,
  `value`, `children`) — the raw input for `A11yNode` in `src/types.ts`.
- WebSocket frames are captured separately via CDP
  (`Network.webSocketFrameReceived` / `Network.webSocketFrameSent`) and map to
  `WebSocketFrame` in the canonical types.

## Verification

```bash
npx playwright install chromium   # driver install
node --input-type=module -e "import('playwright').then(p => console.log(typeof p.chromium.connectOverCDP))"
```
