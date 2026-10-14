# Apograph Engineering Roadmap

This roadmap outlines the technical evolution of Apograph from its initial cleanroom recreation baseline to advanced authenticated workflow capture, multi-framework synthesis, and autonomous visual convergence.

---

## Milestone v0.1.0: Core Recreation Engine (Current)

- [x] Automated multi-page crawling via headless Chromium.
- [x] Subpath scoping (single page, subtree, full site) and canonical redirect resolution.
- [x] Schema-validated plan approval gate (`apograph-plan.json`).
- [x] Multi-stage multimodal vision prompting with desktop and mobile screenshot pairs.
- [x] Standalone React 19.3 + Vite + React Router v7 + Tailwind CSS v4 output.
- [x] 3-tier verification: build checks, ephemeral route loading, and pixelmatch visual diffs.
- [x] Local vision model execution via Ollama (`apograph-qwen35:9b-8k`).
- [x] Process controls: SIGINT pause/save modal, stage checkpointing, and `apograph status`.

---

## Milestone v0.2.0: Framework Flexibility & Environmental Resilience

### 1. Headed Challenge Pass-Through
- Detect Cloudflare or perimeter WAF challenge pages during initial navigation.
- Temporarily launch a visible browser window allowing human verification, capture valid session cookies, and seamlessly transition back to automated headless crawling.

### 2. Multi-Stack Target Adapters (`--stack`)
- Add Next.js (App Router) target alongside Vite (`--stack nextjs`).
- Output clean server/client component boundaries with static export capabilities (`output: 'export'`).

### 3. Dual-Theme Extraction (Dark Mode)
- Inspect stylesheets for `@media (prefers-color-scheme: dark)` and CSS root dark variables.
- Extract complementary light/dark token sets and generate working theme toggle components with Tailwind `dark:` utilities.

### 4. Cloud Vision Model Presets
- Add first-class flags and provider adapters for high-throughput cloud vision models (e.g. Claude 3.7 Sonnet, GPT-4o, GLM-Flash).

---

## Milestone v0.3.0: Authenticated Sessions & Stateful Dashboards

### 1. Authenticated Session Attachment
- Support attaching to an existing browser profile or authenticated Chromium session.
- Enable recreation of authorized, user-accessible views (e.g., settings panels, account pages, and internal dashboard routes) by leveraging active session cookies and storage.

### 2. Deep Interaction & State Exploration
- Perform automated synthetic interactions during capture: trigger mobile menus, click tabs, expand disclosure items, and open modal dialogs.
- Record secondary state screenshots (`<slug>-dialog-open.png`) to provide explicit visual evidence for nested UI behaviors.

### 3. Mock Endpoint & API Emulation
- Capture client-side API requests, query parameters, and response structures during page exploration.
- Synthesize typed mock API handlers (e.g., Mock Service Worker or local mock endpoints) so recreated forms, lists, and search inputs respond realistically with sample data.

---

## Milestone v0.4.0: Autonomous Visual Convergence

### 1. Closed-Loop Visual Diff Repair
- Connect the tier-3 pixelmatch verifier directly back into the vision synthesis engine.
- If a generated route exceeds the visual threshold, pass the diff overlay image and failing component back to the model with specific localized correction prompts.
- Iterate up to a configurable pass budget to systematically drive visual mismatch below 2%.

### 2. Multi-Breakpoint Responsive Alignment
- Expand viewport capture and verification beyond desktop (1280x800) and mobile (390x844) to include tablet (768x1024) and widescreen (1920x1080) targets.

---

## Milestone v1.0.0: Autonomous Agent Ecosystem

### 1. Complete Model Context Protocol (MCP) Parity
- Maintain full parity between the CLI engine and the MCP server.
- Expose all inspection, planning, synthesis, and verification capabilities as structured tools for AI coding agents (Cursor, Claude Code, Windsurf, OpenCode).

### 2. Single-Command Self-Hosted Package Generation
- Provide bundled, zero-configuration Docker and deployment scaffolds for one-command local hosting of all synthesized assets and frontend services.