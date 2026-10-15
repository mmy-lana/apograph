# Spec: Visual Resilience (Now)

- **Spec ID:** `integration/visual-resilience`
- **Project:** apograph-agents
- **Status:** Draft — Now horizon
- **Supersedes:** visual-repair scope formerly deferred to roadmap milestone v0.4.0
- **Related:** `ROADMAP.md` (Now: Visual Fidelity & Capture Resilience), `specs/integration/spec.md`, `specs/integration/traceability.md`

---

## 1. Scope & Problem Statement

This specification governs the "Now" horizon: visual fidelity and capture resilience. It is written in direct response to the Nirantara clone run (`https://nirantara.id/`) executed against the OpenAI-compatible gateway (`z-ai/glm-5.3-flash`), which failed visual fidelity through six distinct, independently diagnosable failure modes.

### 1.1 Failure Mode Breakdown (Nirantara Post-Mortem)

| # | Failure Mode | Mechanism | Observed Symptom |
|---|---|---|---|
| F1 | Blank redirect frame entering synthesis | Instant client-side redirect from `/` to `/en` captured a 50ms blank screen; the capture loop persisted the transition frame as a route | Dead `routes[0]` with `children: []` |
| F2 | Hardcoded downstream stage anchoring | Stage 2 (Navbar/Footer) hardcodes to `routes[0]`; Stage 3 (HomePage) synthesized blank components from the dead redirect frame | Empty navbar/footer/home scaffolding |
| F3 | Hardcoded light-mode canvas | `App.tsx` emits `bg-white text-neutral-900`; `index.css` emits `--color-background: #ffffff`; component templates assume light | Authentic dark canvas `#080f1c` never rendered |
| F4 | Token vocabulary overload | Over 300 unmapped `--color-apograph-N` CSS tokens presented to the vision LLM | LLM abandoned the token system and fell back to plain monochrome Tailwind utilities |
| F5 | Missing DOM text feed | Only the accessibility tree and screenshots were supplied; the LLM relied on visual OCR | Gradient headline spans ("TECHNOLOGY & AI PARTNER", "BUSINESS") dropped from output |
| F6 | Misleading provider reporting | Terminal progress spinner hardcodes `'via local model'` regardless of the active provider route | User believes a cloud gateway run is a local model run |

A seventh, roadmap-level defect: `ROADMAP.md` listed `v0.1.0` as current and deferred visual repair to `v0.4.0` while `package.json` was already `0.2.0`. This is corrected by the Now/Next/Later roadmap restructure; that fix is organizational, not code.

### 1.2 In Scope

- Automated capture health checks (blank detection, redirect aliasing).
- Gate 1: interactive Evidence Review Gate, plus non-interactive / MCP behavior.
- Canvas theme extraction and removal of hardcoded light-mode styling.
- DOM text corpus harvesting.
- Cloud vision presets with dynamic provider reporting.
- Single-turn closed-loop visual diff repair.

### 1.3 Out of Scope

- Multi-breakpoint capture beyond existing desktop/mobile pairs (Next horizon).
- Headed challenge pass-through, multi-stack targets (Next horizon).
- Authenticated sessions, synthetic interaction discovery, MSW generation, full MCP autonomy (Later horizon).
- Iterative multi-turn visual convergence budgets beyond the single-turn repair pass.

---

## 2. Automated Health Checks

Capture health checks run on every harvested frame after screenshot capture and before evidence persistence or plan generation. A frame is classified as **suspect** or **healthy**; suspect frames are candidates for Gate 1 review (interactive) or automatic pruning (non-interactive).

### 2.1 Blank Screenshot Detection

A captured frame is classified **blank** when either condition holds:

1. **DOM emptiness:** the frame's harvested DOM snapshot contains 0 visible element nodes (text-bearing or otherwise) beneath `document.body`.
2. **Pixel uniformity:** more than 95% of the screenshot's pixels fall within a perceptual tolerance (Euclidean RGB distance <= 16, i.e. roughly one `#0f0f0f` step) of the single most common color.

Both checks are cheap and run unconditionally. The classifier returns a structured verdict:

```ts
type CaptureHealth = {
  blank: boolean;
  reason: 'no-dom-nodes' | 'uniform-pixels' | 'both' | null;
  uniformityRatio: number; // fraction of pixels matching dominant color, [0,1]
  dominantColor: string | null; // e.g. '#ffffff'
  visibleNodeCount: number;
};
```

A blank frame is never eligible to enter synthesis. It may be retained on disk under `.apograph/evidence/screenshots/` for review, but is marked suspect.

### 2.2 Instant Redirect Detection

A frame is classified as an **instant redirect transition frame** when all hold:

1. Navigation landed on URL A (e.g. `/`), and a client-side or HTTP redirect resolved to URL B (e.g. `/en`) within the frame's settle window (default threshold: < 500ms between initial navigation commit and final URL stability).
2. The pre-redirect frame is blank per §2.1.
3. The final URL B has its own, independently captured healthy frame.

When detected, the capture engine must **alias** rather than record the transition frame:

- No route entry is created for the transition URL A.
- The plan's route table maps A -> B (alias), so generated router configs may still register `"/"` as a redirect to `"/en"` (preserving source-site behavior) without ever synthesizing a component for A.
- The blank transition frame is marked suspect and excluded from stage anchoring (see F2: no stage may hardcode `routes[0]` — stage anchoring must instead select the first **healthy** frame in route-declaration order).

---

## 3. Gate 1: Evidence Review Gate Specification

Gate 1 is the interactive review checkpoint inserted between crawl completion and plan generation. Its contract: no evidence enters synthesis without either explicit human approval (interactive mode) or automated health-check filtering (non-interactive mode).

### 3.1 Interactive CLI Workflow

Invoked as the default behavior of `apograph plan` (and the crawl subcommand when run with `--review`).

**Step 1 — Evidence summary table.** The CLI prints one row per captured route:

```
#   Route           Status    Health   DOM nodes   Uniformity   Screenshot
1   /               ALIAS     -        0           100% (#ffffff)  (transition frame)
2   /en             OK        HEALTHY  412         2.1% (#080f1c)  home-en.png
3   /en/services    OK        HEALTHY  388         1.8% (#080f1c)  services.png
4   /en/about       OK        SUSPECT  6           99.2% (#e5e7eb) about.png
```

Status values: `OK`, `ALIAS` (redirect-aliased per §2.2), `SUSPECT` (blank or degraded), `ERROR` (capture failure). Suspect rows are visually flagged.

**Step 2 — File manager launcher.** A prompt action opens the platform file manager at the evidence directory (`open .apograph/evidence/screenshots/` on darwin, `xdg-open` on Linux, `start` on Windows), letting the reviewer inspect full-resolution captures directly rather than terminal thumbnails.

**Step 3 — Selective action selection.** The reviewer may, per route index:

- **Re-crawl** one or more specific routes by index (e.g. `2,5,7` or ranges `2-5`), re-running capture for only those routes while preserving the rest of the evidence set.
- **Prune** a route, removing it from the route table and synthesis inputs entirely.
- **Alias** a route to another route (marking it as redirect-only), for cases the automated detector missed.
- **Approve** the evidence set as-is, advancing to plan generation.
- **Abort**, exiting without side effects on the evidence directory.

Invalid indices, empty selections on required actions, and alias targets that are themselves suspect are rejected with actionable error messages.

**Step 4 — Post-action re-check.** Re-crawled routes re-run the §2 health checks; the summary table is re-rendered and the reviewer returns to Step 3. The gate cannot be passed while any route is classified suspect unless the reviewer explicitly prunes or approves it (approval of suspect routes requires a `--force`-grade confirmation).

### 3.2 Non-Interactive / MCP Behavior

When `--no-review` is passed, or the engine is driven through the MCP server (no TTY), the gate degrades to automated filtering:

1. Instant redirect transition frames are aliased per §2.2 automatically.
2. Blank-classified frames are pruned from the synthesis input set automatically (screenshots retained on disk for post-hoc inspection).
3. The gate emits a structured summary of every automated decision into the evidence directory (`evidence-gate.json`), including the health verdict per route and the alias/prune actions taken, so a later interactive run can audit or overturn the automated choices.

No interactive prompt may block a non-interactive run under any condition.

---

## 4. Canvas Theme & Styling Specifications

### 4.1 Computed Background Extraction

During crawl, for each healthy frame, the harvester reads the computed style of `document.body`:

```ts
const computed = getComputedStyle(document.body);
const canvasToken = {
  backgroundColor: computed.backgroundColor, // e.g. 'rgb(8, 15, 28)'
  color: computed.color,
};
```

The crawl-scoped **dominant canvas** is the most frequent non-blank `backgroundColor` across healthy frames, normalized to a hex token (for Nirantara: `#080f1c`). It is recorded in the evidence set and the plan.

### 4.2 Elimination of Hardcoded Light Wrappers

- `App.tsx` template must not contain literal `bg-white` or `text-neutral-900`; the shell wrapper uses the synthesized canvas token (e.g. `bg-[#080f1c]` or a generated `--color-background` value resolved from the crawl).
- `index.css` template must not contain a literal `--color-background: #ffffff`; the generated stylesheet defines `--color-background` from the extracted dominant canvas (with the light-mode default used only when the source site genuinely computes a white body background).
- Component stage templates must inherit canvas color from the shell (`bg-transparent` / inherited `color`) rather than re-declaring light backgrounds.

### 4.3 Prompt Instruction Shift: Arbitrary Classes over Rigid Tokens

The synthesis prompt contract changes from "use the mapped `--color-apograph-N` variables" to:

- The vision LLM is given the extracted canvas token and the site's **reduced** palette (top-N colors by usage, N <= 24, derived from computed styles).
- The LLM is explicitly permitted and encouraged to use arbitrary Tailwind value classes — `bg-[#080f1c]`, gradient utilities (`bg-gradient-to-r from-cyan-400 to-blue-500`), `text-cyan-400`, opacity and blur utilities — when they visually match the evidence.
- Unmapped site CSS variables are no longer enumerated in the prompt. The prior behavior (300+ `--color-apograph-N` tokens) is prohibited; it measurably drove the monochrome fallback (F4).

---

## 5. Text Corpus Extraction

### 5.1 Harvester Contract (`src/harvester/dom.ts`)

Alongside the existing accessibility-tree capture, the harvester must produce a **visible text corpus** per frame:

- Traversal: depth-first over elements under `document.body`, in document order.
- Visibility filter: only elements whose computed style yields non-zero bounding box, `visibility != 'hidden'`, `display != 'none'`, and non-transparent (alpha > 0) text color.
- Capture unit: the **text span** — for each visible text node, record the text content plus the element's effective gradient/color styling:

```ts
type TextSpan = {
  text: string;                 // trimmed visible text
  gradient?: string;            // computed background-image if gradient text (text-fill/clip or bg-clip)
  color: string;                // computed color, e.g. 'rgb(6, 182, 212)'
  tag: string;                  // element tag, e.g. 'span', 'h1', 'p'
  parentTag: string;            // nearest semantic ancestor, e.g. 'h1'
};
```

- Gradient headline spans (elements with `background-image: linear-gradient(...)` combined with `background-clip: text` / `-webkit-text-fill-color`) must be captured with their gradient definition verbatim — this is the direct remedy for the dropped "TECHNOLOGY & AI PARTNER" / "BUSINESS" spans (F5).

### 5.2 Synthesis Feed

- The text corpus is attached to each route's evidence payload and included in the Stage 2/Stage 3 prompts as a structured text manifest (tagged per element), so string-level fidelity is grounded in DOM data rather than OCR.
- Headings and hero spans from the corpus are surfaced with priority ordering (h1 > h2 > ... > strong > default) in the prompt.

---

## 6. CLI & Diagnostics

### 6.1 Dynamic Provider Reporting

- All progress spinners and stage logs must report the active model route dynamically as `${provider} (${modelId})` — e.g. `Synthesizing route /en via z-ai (glm-5.3-flash)` or `via ollama (apograph-qwen35:9b-8k)`.
- The literal string `'via local model'` is removed; hardcoding provider text anywhere in the progress/rendering layer is prohibited.
- Provider and model are read from the resolved model route configuration at render time, not captured at startup, so runtime route changes are reflected.

### 6.2 `apograph config` Gateway Presets

- `apograph config` gains non-destructive prompts for vision provider selection: local (Ollama) or OpenAI-compatible gateway.
- Gateway configuration collects: base URL, API key (stored via the existing secrets mechanism, never echoed in plaintext), model ID, and optional request tuning (timeout, concurrency).
- A **GLM 5.3 Flash preset** ships as a first-class option (provider label `z-ai`, default model `glm-5.3-flash`) so the Nirantara-class gateway is a selection, not manual assembly.
- All prompts default to current values on empty input; `apograph config` never rewrites a config file it did not intentionally change (non-destructive: unknown keys preserved, existing values surfaced as defaults).

---

## 7. Closed-Loop Visual Diff Repair (Single-Turn)

- When tier-3 pixelmatch verification reports a route exceeding the visual threshold, the verifier output (diff overlay image + per-region mismatch metrics + the failing component's source path) is fed back to the synthesis model in a **single repair turn**.
- The repair prompt is localized: it names the failing component file, embeds the original screenshot and the diff overlay side by side, and instructs a targeted correction (not a from-scratch re-synthesis of the route).
- The repaired component re-enters verification. One repair pass per failing route per run; multi-turn convergence budgets remain in the Later horizon.
- Repair pass outcomes are recorded in the verification report: routes repaired, threshold before/after, and unrepaired residuals — feeding future fidelity metrics.

---

## 8. Traceability & Test Matrix

All tests use the built-in `node:test` runner, colocated with the module under test (`*.test.ts`). The matrix below is the acceptance gate for this spec.

### 8.1 Redirect Aliasing (§2.2)

| Test | Assertion |
|---|---|
| `classifyRedirect > aliases instant client-side redirect` | Given a blank pre-redirect frame on `/` and a healthy frame on `/en` with settle time < 500ms, the classifier returns `{ alias: true, from: '/', to: '/en' }` and emits no route entry for `/`. |
| `classifyRedirect > preserves slow-transition frame` | Given a non-blank frame on `/` (settle time 1200ms, healthy DOM), no alias is emitted; `/` remains a standalone route. |
| `classifyRedirect > blank frame without healthy target stays suspect` | Given a blank frame on `/x` with no healthy resolved target, the frame is classified suspect, not aliased. |
| `plan > alias target receives redirect route entry` | The generated plan registers `/` as a redirect to `/en` with no component synthesis for `/`. |

### 8.2 Blank Capture Classification (§2.1)

| Test | Assertion |
|---|---|
| `health > zero DOM nodes classifies blank` | A synthetic frame with `visibleNodeCount: 0` returns `blank: true, reason: 'no-dom-nodes'`. |
| `health > uniform pixels classify blank` | A synthetic 1280x800 screenshot with 97% pixels equal to `#ffffff` returns `blank: true` with `uniformityRatio >= 0.95` and `dominantColor: '#ffffff'`. |
| `health > dark canvas is not blank` | A screenshot at 97% `#080f1c` with `visibleNodeCount: 380` returns `blank: false` (node count disambiguates a real dark page from a blank dark frame). |
| `health > gradient hero is not uniform` | A screenshot with a gradient headline spanning >5% of pixels returns `uniformityRatio < 0.95`, `blank: false`. |

### 8.3 Dynamic Background Resolution (§4.1, §4.2)

| Test | Assertion |
|---|---|
| `theme > extracts computed body background` | Given a harvested style record `backgroundColor: 'rgb(8, 15, 28)'`, the resolver emits canonical token `#080f1c`. |
| `theme > dominant canvas wins across frames` | Given per-frame backgrounds `['rgb(8,15,28)', 'rgb(8,15,28)', 'rgb(255,255,255)']` (the white being a blank-classified frame), the dominant non-blank canvas is `#080f1c`. |
| `templates > App shell emits no hardcoded light wrapper` | The rendered `App.tsx` template contains neither the literal `bg-white` nor `text-neutral-900`; it references the synthesized canvas token. |
| `templates > index.css background is dynamic` | The rendered `index.css` contains `--color-background: #080f1c` (from extraction) and never the literal `--color-background: #ffffff` unless the source body background was computed white. |
| `prompt > palette is reduced` | The synthesis prompt payload contains at most 24 palette entries and no `--color-apograph-*` variable enumeration. |

### 8.4 Text Corpus (§5)

| Test | Assertion |
|---|---|
| `dom > harvests visible text spans in order` | A fixture DOM with h1/span/p yields `TextSpan[]` in document order with correct tags. |
| `dom > captures gradient headline spans` | An element with `background-image: linear-gradient(...)` and `background-clip: text` yields a span with `gradient` set verbatim and the full text (e.g. "TECHNOLOGY & AI PARTNER") preserved. |
| `dom > skips hidden elements` | `display: none`, `visibility: hidden`, zero-box, and alpha-0 text elements yield no spans. |

### 8.5 Gate 1 & Diagnostics (§3, §6)

| Test | Assertion |
|---|---|
| `gate > non-interactive prunes suspect frames` | A non-interactive run over evidence containing one alias-eligible and one blank route emits `evidence-gate.json` with the alias and prune recorded, and excludes both from synthesis inputs. |
| `gate > selective re-crawl parses indices` | Selection input `2,5,7` and `2-5` parse to the correct route index sets; invalid indices are rejected. |
| `progress > reports dynamic provider` | Given a model route `{ provider: 'z-ai', modelId: 'glm-5.3-flash' }`, the rendered progress line contains `via z-ai (glm-5.3-flash)`; the literal `via local model` appears nowhere in the output. |
| `config > prompts are non-destructive` | `apograph config` with empty-input (defaults accepted) leaves unknown keys and existing values byte-identical; the GLM 5.3 Flash preset resolves to provider `z-ai`, model `glm-5.3-flash`. |
| `repair > single-turn repair re-enters verification` | A failing route triggers exactly one repair turn whose prompt embeds the diff overlay and names the failing component; post-repair metrics are recorded. |

### 8.6 Traceability Ledger

Each shipped behavior must reference its spec section in the test file header comment (`// spec: integration/visual-resilience §x.y`), and `specs/integration/traceability.md` is updated with the requirement-to-test mapping at merge time.

---

## 9. Acceptance Criteria (Summary)

The Now horizon is complete when, re-running the Nirantara clone against the GLM 5.3 Flash gateway:

1. No blank `routes[0]` exists; `/` is aliased to `/en` in the generated router.
2. The generated app renders on the `#080f1c` canvas with no hardcoded white wrappers in `App.tsx` or `index.css`.
3. Gradient headline spans ("TECHNOLOGY & AI PARTNER", "BUSINESS") appear verbatim in the output, grounded in the DOM text corpus.
4. The prompt payload carries a reduced palette (<= 24 colors), no `--color-apograph-N` enumeration.
5. Terminal output reports `z-ai (glm-5.3-flash)` throughout.
6. Failing routes receive exactly one localized pixelmatch-guided repair pass, with before/after metrics recorded.
