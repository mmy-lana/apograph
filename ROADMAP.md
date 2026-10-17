# Apograph Engineering Roadmap

This roadmap outlines the technical evolution of Apograph from its cleanroom recreation baseline toward advanced authenticated workflow capture, multi-framework synthesis, and autonomous visual convergence.

Apograph has moved away from rigid semver-numbered milestones. Version numbers in `package.json` track published artifacts; they no longer sequence engineering work. Instead, work is organized in three operational horizons: **Now**, **Next**, and **Later**. An item's horizon reflects its operational priority and readiness, not a promised release version. Items graduate between horizons as evidence — captured failure modes, verification metrics, and user demand — accumulates.

---

## Now: Visual Fidelity & Capture Resilience

The immediate focus is eliminating the failure modes surfaced by the dark-canvas SPA case study (`https://example-spa.com`) against the GLM 5.3 Flash gateway: blank redirect frames entering synthesis, hardcoded light-mode canvas overriding the authentic dark theme, dropped gradient text, and an overwhelming CSS token vocabulary that forced monochrome fallbacks.

### 1. Gate 1: Evidence Review Gate
- Automated blank screenshot detection before synthesis: flag captures with 0 DOM nodes or >95% uniform pixel coverage.
- Automated instant redirect detection: alias `/` to its resolved destination (`/en`) instead of capturing the empty 50ms transition frame as a dead `routes[0]`.
- Interactive CLI review workflow after crawl: evidence summary table, system file manager launcher for `.apograph/evidence/screenshots/`, selective route re-crawl selection (e.g. routes 2, 5, 7), and route prune/alias controls.
- Non-interactive / MCP behavior: automatically prune suspect redirect frames so headless pipelines never synthesize from a blank frame.
- Full specification: `specs/integration/visual-resilience.md`.

### 2. Canvas Theme Extraction
- Extract the computed `document.body` background color during crawl (e.g. `#080f1c`) and propagate it as the canonical canvas token.
- Eliminate hardcoded light wrappers: `bg-white text-neutral-900` in `App.tsx` and `--color-background: #ffffff` in `index.css` are replaced with dynamically resolved theme tokens.
- Remove hardcoded light-mode assumptions from component templates so dark canvases survive synthesis.

### 3. DOM Text Corpus Feed
- Harvest visible DOM text spans (including gradient headline spans such as "TECHNOLOGY & AI PARTNER" and "BUSINESS") alongside the accessibility tree.
- Feed the text corpus to the vision LLM so string-level fidelity no longer depends on visual OCR.
- Specification target: `src/harvester/dom.ts`.

### 4. Cloud Vision Presets
- First-class GLM 5.3 Flash OpenAI-compatible gateway configuration alongside local models.
- Dynamic terminal progress reporting: replace the hardcoded `via local model` spinner with `${provider} (${modelId})` resolved from the active model route.
- Non-destructive `apograph config` prompts with presets for custom OpenAI-compatible gateways.

### 5. Closed-Loop Visual Diff Repair — shipped
- Connect the tier-3 pixelmatch verifier directly back into the vision synthesis engine.
- Bounded route-local repair turns target the worst current viewport with localized correction prompts.
- Keep/revert protection retains only measurable improvements and restores regressions, failed builds, and no-progress candidates.
- `verify` exposes `--no-repair` and `--max-repair-turns <n>` controls.

### 6. Live Original Comparison — shipped
- `clone-verify` compares the running clone against fresh screenshots from the live original URL and reports per-route pixel similarity, fonts, colors, and missing animation names.
- `clone` can run a final live gate with `--live-verify`, `--live-threshold <percent>`, and an optional single `--live-retry`.
- First and second live attempts are preserved separately; failed live verification never triggers destructive recloning automatically.
- The live gate is a measurement and bounded retry mechanism, not a promise of perfect cloning.

---

## Next: Multi-Framework & Advanced Convergence

Once capture is trustworthy at the evidence level, breadth work resumes.

### 1. Multi-Breakpoint Alignment
- Expand viewport capture and verification beyond desktop (1280x800) and mobile (390x844) to tablet (768x1024) and widescreen (1920x1080).
- Per-breakpoint diff attribution so repair prompts name the breakpoint responsible for a mismatch.

### 2. Headed Challenge Pass-Through
- Detect Cloudflare or perimeter WAF challenge pages during initial navigation.
- Temporarily launch a visible browser window allowing human verification, capture valid session cookies, and transition back to automated headless crawling.

### 3. Multi-Stack Targets
- Add Next.js (App Router) as a synthesis target alongside Vite (`--stack nextjs`).
- Output clean server/client component boundaries with static export capabilities (`output: 'export'`).

---

## Later: Deep Capture & State

Deep interactivity and autonomy work, deferred until the Now horizon holds a verified fidelity floor.

### 1. Authenticated Session Attachment
- Support attaching to an existing browser profile or authenticated Chromium session.
- Enable recreation of authorized views (settings panels, account pages, internal dashboard routes) using active session cookies and storage.

### 2. Synthetic Interaction Discovery
- Perform automated synthetic interactions during capture: trigger mobile menus, click tabs, expand disclosures, open modal dialogs and drawers.
- Record secondary state screenshots (`<slug>-dialog-open.png`) as explicit visual evidence for nested UI behaviors.

### 3. Client-side API Capture & Typed MSW Generation
- Capture client-side API requests, query parameters, and response structures during page exploration.
- Synthesize typed Mock Service Worker handlers so recreated forms, lists, and search inputs respond realistically with sample data.

### 4. Complete MCP Autonomous Ecosystem
- Maintain full parity between the CLI engine and the MCP server.
- Expose inspection, planning, synthesis, verification, and repair capabilities as structured tools for AI coding agents (Cursor, Claude Code, Windsurf, OpenCode).
- Extend the bounded route-local repair budget toward a configurable, explicitly authorized autonomous loop with full cross-route regression checks.

---

## Horizon History

Legacy semver-numbered milestones are retained for traceability only:

- **v0.1.0 — Core Recreation Engine** (shipped): headless Chromium crawling, subpath scoping, schema-validated plan gate, multi-stage multimodal prompting, React 19.3 + Vite + React Router v7 + Tailwind CSS v4 output, 3-tier verification, local Ollama vision execution, process controls.
- **v0.2.0 — Framework Flexibility & Environmental Resilience** (shipped as package version; its visual-fidelity scope moved into **Now**; multi-stack and challenge pass-through moved into **Next**).
- **v0.3.0 — Authenticated Sessions & Stateful Dashboards** (absorbed into **Later**).
- **v0.4.0 — Autonomous Visual Convergence** (bounded keep/revert repair and optional one-retry live comparison moved into **Now**; unbounded autonomy remains **Later**; multi-breakpoint alignment remains **Next**).
- **v1.0.0 — Autonomous Agent Ecosystem** (absorbed into **Later**).
