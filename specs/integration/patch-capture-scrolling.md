# Patch Spec: Capture Scrolling & In-Page Evaluation Isolation

- **Spec ID:** `integration/patch-capture-scrolling`
- **Project:** apograph-agents
- **Status:** Draft — patches the "Now" horizon of `specs/integration/visual-resilience.md`
- **Amends:** `src/harvester/dom.ts` (s5.1), `src/crawler/engine.ts` (s2, s3), verification tier 3 assumptions
- **Related:** `specs/integration/visual-resilience.md` (s2, s5, s8.4, s8.5)
- **Discovered in:** dark-canvas SPA end-to-end run (`https://example-spa.com`)
- **Amendments:** A1 (hardened scroll reset contract — supersedes the fixed `RESET_DELAY_MS` blind wait in s3.1; see s8)

---

## 1. Purpose & Problem Statement

Two live capture defects surfaced in the end-to-end run against the full pipeline:

| # | Defect | Site of Failure | User-Visible Symptom |
|---|---|---|---|
| D1 | `page.evaluate(collectRawTextSpans)` threw `ReferenceError: SEMANTIC_ANCESTORS is not defined` | `src/harvester/dom.ts` (Phase 4 text corpus harvest) | Entire capture route fails its DOM snapshot; text corpus is lost, and the crawl may abort the route entirely |
| D2 | Lazy-loaded content (Framer Motion reveals, AOS, IntersectionObserver animations, `loading="lazy"` images) never rendered before capture | `src/crawler/engine.ts` | Below-the-fold text spans and mirrored image assets are missing from evidence; below-the-fold screenshots are truncated or blank-adjacent, and tier-3 visual diffs show phantom mismatches against a more-complete reference |

Both defects attack the same guarantee the Now horizon exists to provide: that synthesis inputs are grounded in what the source site actually renders, not in a partially loaded or error-degraded DOM.

### 1.1 Root Cause Analysis

**D1 — Isolated world lexical scope.** Chromium executes `page.evaluate(fn)` by serializing the function's source and re-evaluating it inside the page's browser V8 context. The serialized body references module-scope identifiers (`SEMANTIC_ANCESTORS`, and any helper sub-functions) that exist only in the Node.js process. The reference is resolved at evaluation time, in the browser, where the binding does not exist. TypeScript cannot catch this: the reference type-checks cleanly in Node scope. The same latent hazard applies to every in-page collector already in the codebase (`collectCssText`, `collectBodyComputedStyle`, `countVisibleNodesInPage` in `engine.ts` — each currently happens to be self-contained; nothing enforces that).

**D2 — Capture-time assumption of a settled page.** The crawl loop captures immediately after `page.goto(..., { waitUntil: 'networkidle' })` plus fixed-viewport screenshot calls. `networkidle` only asserts a network-quiet window; it says nothing about scroll-triggered work. Modern SPA animation and lazy-load libraries gate rendering on the element entering the viewport. A first-viewport capture therefore systematically misses everything below the fold, and `loading="lazy"` assets are never requested, so asset discovery (`discoverImageAssets`) never sees them.

---

## 2. Contract Requirements: `src/harvester/dom.ts`

### 2.1 In-Page Evaluation Boundary Rules (D1)

**Rule 1 — Complete closure.** Every function passed to `page.evaluate` (or `page.$$eval`, `page.evaluateHandle`) must be lexically self-contained: every constant, lookup set, regular expression, and helper sub-function it references must be declared inside its own function body. No reference to any module-scope binding may appear anywhere in the evaluated function, including inside nested closures.

**Rule 2 — No implicit global capture.** Evaluated functions must not reference Node-provided globals (`process`, `Buffer`, module imports) or browser-assumed globals beyond the standard DOM/BOM surface (`document`, `window`, `getComputedStyle`, `NodeFilter`, `Text`, `Element`).

**Rule 3 — Serialization sanity.** Because Playwright ships the function source to the browser, the function must remain a plain function declaration/expression; no TypeScript-only syntax may survive compilation inside the serialized body beyond what tsc already erases, and no closure over `this` from the Node side.

**Rule 4 — Declared export boundary.**

- Exported for Node.js unit testing (pure, browser-free): `buildTextSpans`, `isGradientText`, `isTransparentColor`, `normalizeColorToHex`, and their input types (`RawTextSpan`).
- Strictly self-contained (never referenced from module scope, never exported): `collectRawTextSpans`, `collectCssText`, `collectBodyComputedStyle`. The only permitted interaction with these is as the direct argument to `page.evaluate`.
- The bridge between the two halves is data-only: `collectRawTextSpans` returns plain JSON-serializable `RawTextSpan[]`; `buildTextSpans` consumes them in Node.

**Rule 5 — Static guard.** A regression test (see s5.3) must statically verify that the in-page collectors reference no module-scope identifiers, so a future edit cannot reintroduce D1 silently.

### 2.2 Required Refactor Shape (informative, not code)

`collectRawTextSpans` must move the semantic-ancestor set and the ancestor-walking logic inside its own body, e.g. as a local constant and a local function. The set's contents (h1–h6, p, li, a, button, blockquote, figcaption, summary, label, dt, dd) and the resolution rule (nearest semantic ancestor, else the parent tag, else the element's own tag) are unchanged from `visual-resilience.md` s5.1; only their lexical home moves. The pure pipeline (`buildTextSpans` and friends) is unchanged in behavior, signature, and exports.

---

## 3. Contract Requirements: `src/crawler/engine.ts` (D2)

### 3.1 Incremental Auto-Scroll Contract

A bounded auto-scroll pass runs after `page.goto` settles and before any snapshot, screenshot, health check, or asset discovery for the route.

**Scroll mechanics:**

- Incrementally scroll the page in discrete steps (documented step size: approximately one viewport height per step) until the maximum scroll position stops increasing between two consecutive steps (page bottom reached), or a bound trips.
- After the final step, scroll once more to the true bottom (`scrollHeight`) to trigger any tail-end observers.

**Bounded execution (both bounds mandatory):**

- **Step bound:** maximum number of scroll steps per route (default: 30). Guards against infinite-scroll pages where the bottom never converges because content is continuously appended.
- **Time bound:** maximum wall-clock duration for the entire scroll pass (default: 5000 ms). Guards against slow observers re-appending content faster than the crawler advances. Whichever bound trips first terminates the pass; termination is a normal outcome, not an error, and is recorded as a diagnostic note when the step bound was the terminator (indicating a probable infinite-scroll page).

**Settle delay:**

- After the scroll pass reaches its end (bottom reached or bound tripped), wait a documented settle window (default: 750 ms) before capture so that: (a) any trailing network requests initiated by newly revealed observers can begin, and (b) DOM layout and text-injection observers (Framer Motion reveal completion, AOS `aos-animate` class application, lazy `src` resolution) finish mutating the DOM.
- The settle window is capped and not wait-on-network: `networkidle` was already satisfied pre-scroll; re-entering a full network-idle wait after scroll risks pathological waits on analytics beacons. A bounded delay plus the capture loop's existing tolerance is the contract.

**Viewport reset:**

- Immediately before snapshot/screenshot capture, reset scroll position to `(0, 0)` and wait one animation frame interval (or a short fixed delay, default: 150 ms).
- Rationale: sticky headers, scroll-triggered nav state (shrunk headers, changed nav background), scroll-progress indicators, and scroll-linked hero animations (Framer Motion `useScroll`) must be captured in their initial visual state, matching the reference presentation a first-visit user sees. Without the reset, tier-3 screenshots would compare a scrolled-state synthesized page against an at-top reference, producing phantom mismatches.
- The reset applies to both the health-check screenshot and the desktop/mobile evidence captures, and to the re-capture path in `src/plan/evidenceGate.ts` (`recrawlRoute`), which shares the same capture ordering.

**Capture ordering contract (per route):** goto settle → auto-scroll pass → settle delay → scroll reset to (0,0) → reset delay → visible-node count → screenshots → DOM snapshot → metadata. Asset discovery runs after the scroll pass so lazy `src` attributes have been resolved.

### 3.2 Full-Page Capture Contract

- The **desktop evidence screenshot** must be captured with `fullPage: true` after the auto-scroll pass, so below-the-fold sections are present in the evidence bundle for the vision model.
- The **mobile evidence screenshot** is captured with `fullPage: true` under the same contract.
- Capture health checks (s2.1 uniformity analysis) operate on the full-page capture unchanged: a lazy-loaded page that failed to render still produces a mostly-uniform frame and is still flagged; a healthy full-page capture has strictly more content and cannot become blank by the change.

**Impact on tier-3 pixelmatch verification — dimension alignment:**

- The verifier's desktop/mobile comparisons use fixed 1280x800 and 390x844 viewports. A full-page reference screenshot may be taller than the viewport. The existing `conformToDimensions` helper in `src/verifier/engine.ts` crops/pads the current viewport capture to the reference's dimensions; with full-page references, that crop would compare only the top viewport-height slice of the reference against the synthesized page's at-top viewport screenshot, and the padded remainder would inflate the mismatch denominator.
- Contract: when the reference screenshot height exceeds the verification viewport height, the verifier must crop the reference to the verification viewport dimensions (top-anchored, since the scroll reset guarantees both are in the at-top state) before comparison, so compared surfaces are strictly viewport-sized. The cropped comparison is recorded with a note (`reference cropped from N px to viewport height`) in the `VisualCheck`.
- The diff overlay and repair pass (s7) semantics are unchanged; repairs receive the at-top reference and the diff overlay as before.

### 3.3 Manifest & Diagnostics

- The manifest records per-route scroll diagnostics when they materially deviate: step-bound termination (probable infinite scroll) is recorded in `diagnostics.skippedUrls`-style notes or a dedicated diagnostic string, so Gate 1 reviewers and post-hoc audits can see that a page never converged.
- No schema change is required for the base contract; the scroll-pass note is a diagnostic string. (An optional `scrollTerminatedBy: 'bottom' | 'steps' | 'timeout'` field on the route may be added without breaking existing consumers, as `CrawlRoute` extensions are additive.)

---

## 4. Edge Case Safeguards

| Edge Case | Risk | Required Safeguard |
|---|---|---|
| Infinite-scroll pages (feed, chat, virtualized lists) | Scroll pass never converges; crawl hangs | Dual bounds (s3.1): step cap and time cap; whichever trips first ends the pass. Termination is not an error. |
| Scroll-triggered content growth loop | Each step appends exactly enough content that the max scroll keeps increasing until the time bound | Time bound is wall-clock across the whole pass, not per step, so aggregate runtime is capped regardless of append rate. |
| Zero-height or display-constrained body (`body { height: 0 }`, `overflow: hidden` shells, cookie-wall interstitials) | `window.scrollTo` no-ops; max scroll stays 0; pass could loop on "no progress" logic | First step with unchanged `scrollY` and `scrollHeight <= viewport height` terminates immediately as `bottom reached` (no steps wasted). A zero-render body then flows into the existing blank-capture health check (s2.1), which flags it. |
| Fixed/sticky layout shifts during scroll | Sticky headers stack or animate; scroll-linked parallax leaves the page in a non-initial state at capture | Mandatory viewport reset to (0, 0) plus a settle delay before every screenshot/snapshot (s3.1); reset also re-triggers any `scrollend`-dependent styles at the top. |
| `scroll-behavior: smooth` sites | Programmatic `scrollTo` animates asynchronously; next step reads a stale scrollY and misjudges progress | Scroll steps use instant positioning (e.g. `window.scrollTo({ top, behavior: 'instant' })` or direct `scrollTop` assignment); never rely on smooth scroll completing between steps. |
| Oversized full-page screenshots | PNG exceeds the vision pipeline's `MAX_SCREENSHOT_BYTES` (4 MiB) guard and is silently dropped from prompts | Full-page captures that exceed the prompt budget fall back to viewport-height captures for the prompt path (the evidence file on disk remains full-page); the fallback is a diagnostic note, not an error. |
| Reduced-motion / `prefers-reduced-motion` sites | Animation libraries may render everything immediately; scroll pass adds latency without benefit | The bounds make the pass cheap on such pages (bottom reached quickly); no special-casing required — but the pass must never be skipped conditionally on heuristics, because detecting "is this page lazy" reliably is not possible. |
| SPAs that destroy/rebuild DOM on scroll (carousels) | DOM snapshot after scrolling may describe mid-transition state | DOM snapshot is captured after the scroll reset and settle delay, i.e. at rest at the top; the reset is what guarantees snapshot/capture consistency. |
| Evaluated-function closure regressions (D1 class) | Future collectors reintroduce module-scope references and fail only at runtime on real crawls | Static boundary test (s5.3) plus the export-boundary rule (s2.1 Rule 4) keep the class of defect caught in unit tests. |

---

## 5. Test Requirements & Regression Protection

The existing suite (93 passing tests across `setup`, `config`, `health`, `theme`, `corpus`, `ui`, `gate`, `repair`) must remain green. All existing assertions on pure helpers are unaffected by the D1 refactor because signatures and behavior are unchanged. New assertions:

### 5.1 In-Page Isolation Boundary (D1)

| Test | Assertion |
|---|---|
| `isolation > in-page collectors are lexically self-contained` | Extracts the source of each in-page collector function (`collectRawTextSpans`, `collectCssText`, `collectBodyComputedStyle`, and `engine.ts`'s `countVisibleNodesInPage`, `collectHeadMetadata`) via `Function.prototype.toString` at runtime; for each, assert that no module-scope identifier (enumerate the exported/declared names of `dom.ts`/`engine.ts`) appears as a free reference in the serialized body. Concretely: `collectRawTextSpans.toString()` must contain `SEMANTIC_ANCESTORS` as an internal declaration (the set literal `['h1', ...]` inline) and must not reference any identifier not defined within its own source. |
| `isolation > boundary between Node tests and browser collectors holds` | `buildTextSpans`, `isGradientText`, `isTransparentColor` remain exported and callable without any browser context (existing s8.4 corpus tests already prove this; the new test asserts the export list explicitly). |

### 5.2 Auto-Scroll Contract (D2)

Pure, browser-free units are extracted so the contract is testable without Chromium:

| Test | Assertion |
|---|---|
| `scroll > plan terminates at page bottom` | Given a simulated scroll-height progression that converges (e.g. max scroll stops increasing), the scroll-plan function emits steps ending with `terminatedBy: 'bottom'` and total steps within bounds. |
| `scroll > plan terminates on step bound (infinite scroll)` | Given a progression that always grows, the plan terminates with `terminatedBy: 'steps'` at exactly the configured step cap. |
| `scroll > plan terminates on time bound` | Given a monotonically increasing elapsed clock, the plan terminates with `terminatedBy: 'timeout'` at or before the configured deadline. |
| `scroll > zero-height body terminates immediately` | Given `scrollHeight <= viewportHeight`, the plan emits a single bottom-check step and terminates with `terminatedBy: 'bottom'`, zero scroll steps. |
| `scroll > reset precedes capture` | The capture-ordering function composes (scroll pass, settle, reset, capture) in that order; assert the emitted operation sequence places the reset-to-zero before every screenshot/snapshot call, including in the `recrawlRoute` path. |

### 5.3 Full-Page Capture & Verification Alignment (D2)

| Test | Assertion |
|---|---|
| `capture > full-page screenshots are requested for both viewports` | The screenshot invocation list for a route sets the full-page flag on both desktop and mobile captures. |
| `verify > tall reference is top-anchored cropped to viewport` | Given a reference PNG of 1280x2400 and a 1280x800 current capture, the comparison crops the reference to its top 800 px before pixelmatch; the resulting `VisualCheck` carries the crop note and a viewport-sized diff image. |
| `verify > viewport-sized reference compares unchanged` | A reference already at 1280x800 compares without cropping and without the crop note (existing tier-3 behavior preserved). |

### 5.4 Existing-Suite Regression Matrix

| Existing suite | Impact | Guarantee |
|---|---|---|
| `health.test.ts` (s8.1/s8.2) | None | Health checks read the persisted screenshot bytes; full-page captures flow through the same classifier. Blank/dark-canvas disambiguation semantics unchanged. |
| `theme.test.ts` (s8.3) | None | Canvas extraction reads computed styles; unrelated to scroll or evaluation scoping. |
| `corpus.test.ts` (s8.4) | None — must remain green unchanged | `buildTextSpans`/`isGradientText` signatures and behavior are frozen by this patch; only `collectRawTextSpans`'s internals move. |
| `ui.test.ts` (s8.5) | None | Provider reporting untouched. |
| `gate.test.ts` (s8.5) | None, plus optional coverage | `recrawlRoute` adopts the same scroll/reset ordering; existing gate tests operate on persisted fixtures and are unaffected. A new assertion may extend the re-crawl ordering test (s5.2). |
| `repair.test.ts` (s8.5) | None | Repair pass consumes reference + diff data URLs; only the verifier's reference-cropping prep (s5.3) sits ahead of it, and the repair contract is unchanged. |

---

## 6. Acceptance Criteria (Summary)

The patch is complete when, re-running the dark-canvas SPA clone end-to-end:

1. No `ReferenceError` from any `page.evaluate` call; the text corpus harvest completes on every route, including gradient headline spans.
2. Below-the-fold content (lazy images, scroll-revealed sections) is present in the evidence screenshots and mirrored assets for both desktop and mobile captures.
3. Sticky headers and top-level navigation appear in their initial at-top state in every capture, including Gate 1 re-crawls.
4. Infinite-scroll pages terminate within the configured step/time bounds with a recorded diagnostic, without hanging the crawl.
5. Tier-3 comparisons compare viewport-sized, top-anchored surfaces for full-page references, with crop notes recorded.
6. The full unit suite passes with 0 failures: the existing 93 tests plus the new isolation, scroll-plan, and crop assertions.

---

## 7. Implementation Notes (Non-Normative)

- The scroll pass is best expressed as a pure planner (steps/termination decided from observed scroll metrics) plus a thin in-page executor, mirroring the existing pure-collector / pure-builder split that made D1's fix and test suite possible.
- The evaluation-boundary rule should eventually be enforced mechanically (lint rule or runtime guard in a shared `page.evaluate` wrapper) rather than by discipline alone; this patch specifies the static test as the minimum bar.
- Full-page capture increases evidence PNG sizes; the prompt-size guard already bounds what reaches the model, and the disk bundle is not size-constrained.

---

## 8. Amendment A1: Hardened Scroll Reset Contract (Floating Navbar Displacement)

- **Amendment ID:** A1
- **Status:** Draft
- **Supersedes:** the fixed `RESET_DELAY_MS = 150` blind wait in s3.1 ("reset delay before any snapshot, visible-node count, or screenshot") for the reset phase specifically. All other s3.1 bounds (step cap, time cap, settle delay) and all other sections remain in force.
- **Applies to:** `src/crawler/scroll.ts` (executor), `src/crawler/engine.ts` and `src/plan/evidenceGate.ts` (capture ordering consumers)
- **Discovered in:** dark-canvas SPA full-page capture run (floating navbar rendered mid-page)

### 8.1 Defect Statement (D3 — Floating Navbar Displacement)

In full-page screenshots (`fullPage: true`), the sticky/floating navbar was captured in the middle or lower half of the page instead of resting at the top:

1. The reset in `src/crawler/scroll.ts` calls `window.scrollTo(0, 0)` without `behavior: 'instant'`.
2. Sites declaring `html { scroll-behavior: smooth }` animate that reset asynchronously over 1000–2000 ms.
3. The fixed `RESET_DELAY_MS = 150` expires while the page is still mid-animation. Playwright composites a full-page capture by stitching viewport-sized raster passes, and `position: fixed` / `position: sticky` elements are re-composited at whatever scroll offset exists during each pass — so the navbar is painted at its mid-animation offset rather than at the top.

The result is evidence screenshots whose chrome (navbar, floating headers) is displaced, propagating into: misleading Gate 1 review, vision prompts that teach the model a wrong layout, and tier-3 pixelmatch mismatches/repairs chasing a phantom defect that exists only in the evidence, not the source site.

Root cause: the reset phase conflated "issued a scroll command" with "the viewport is at the top". The contract must be stated in terms of the observable end state (`window.scrollY === 0`), not a fixed latency guess.

### 8.2 Contract Requirements: Hardened Reset Sequence

The reset phase of the capture ordering (s3.1) is replaced by the following mandatory sequence, executed as a single atomic in-page unit wherever it runs (`scroll.ts` executor; consumers must not re-implement it):

**Step R1 — CSS smooth-scroll override.** Before issuing any reset scroll, temporarily force `scroll-behavior: auto` with `!important` on both `document.documentElement` and `document.body` (inline style, overriding any stylesheet or media-query rule). This neutralizes `html { scroll-behavior: smooth }` at the source rather than racing it.

**Step R2 — Instant multi-target scroll reset.** Issue the reset through all of the following, in order, in one in-page evaluation:

- `window.scrollTo({ top: 0, left: 0, behavior: 'instant' })` — the primary path; the explicit `behavior` overrides any inherited smooth behavior at the call site.
- `document.documentElement.scrollTop = 0` — direct assignment for engines/pages where the scrolling element is `<html>` and `scrollTo` behavior options are ignored.
- `document.body.scrollTop = 0` — direct assignment for the legacy case where the scrolling element is `<body>` (quirks-mode or explicitly styled `body { overflow: auto; height: 100vh }` shells).
- Virtual scroll library dispatch: when a known smooth-scroll virtualizer is present on `window`, invoke its immediate API — at minimum `window.lenis?.scrollTo(0, { immediate: true })`, and any additional adapter the implementation registers (documented as an extensible adapter table). The dispatch must be null-safe: absence of the library is the common case and never an error.

**Step R3 — Verified zero-scroll position guard.** Replace the blind `RESET_DELAY_MS` wait with a polling guard: poll `window.scrollY === 0` at a short interval (default: 50 ms) until it holds true, with a hard timeout guard (default: 1000 ms). The guard verifies the observable end state before any screenshot, DOM snapshot, visible-node count, or health check proceeds.

- Success path: `scrollY === 0` confirmed; capture proceeds immediately (no additional fixed delay is required — the poll IS the delay).
- Timeout path: the viewport never confirmed zero (scroll locked by a script, a hijacked scroll container, an interstitial, or a virtualizer that re-scrolls on every reset attempt). The reset terminates safely: capture proceeds with the current position, and the outcome is recorded as a diagnostic (`scroll reset could not confirm top position; captured at offset N px`), never as a thrown error. A displaced capture with a diagnostic is auditable at Gate 1; a crashed route is not.

**Step R4 — Style restoration.** The temporary `scroll-behavior` override from R1 is removed (inline property cleared) after the guard resolves, so the captured DOM snapshot reflects the page's authentic inline styles. Restoration is best-effort and unconditional (including the timeout path) so the page is never left with injected inline styles.

**Ordering contract (amended):** goto settle → auto-scroll (bounded) → settle delay → **hardened reset R1–R4** → visible-node count → screenshots → DOM snapshot → metadata. The executor returns an observable outcome object: `{ confirmedTop: boolean, finalScrollY: number, terminatedBy: 'confirmed' | 'timeout' }`, and consumers record the diagnostic when `confirmedTop === false`.

### 8.3 In-Page Isolation

The entire R1–R4 sequence executes inside `page.evaluate` bodies that remain 100% lexically self-contained per s2.1: the adapter list (Lenis and any others) must be declared inside the evaluated function, and no Node module-scope identifier may be referenced. The pure decision logic (poll planning: interval, deadline, termination classification from observed scroll positions, with an injectable clock and observer stream) remains exported and Node-testable, mirroring the planner/executor split of s3.1.

### 8.4 Edge Case Safeguards (additions to s4)

| Edge Case | Risk | Required Safeguard |
|---|---|---|
| `scroll-behavior: smooth` on `html` or `body` (incl. media-query variants) | Reset animates over 1000–2000 ms; fixed delay expires mid-animation; fixed/sticky chrome painted mid-page | R1 forces `auto !important` on both elements before the reset; R2 uses `behavior: 'instant'` regardless; R3 verifies the end state instead of guessing latency. |
| Scrolling element is `body`, not `html` | `window.scrollTo` with behavior options is ignored on some engines; reset silently no-ops | R2 assigns `scrollTop` on both `documentElement` and `body`. |
| Lenis / virtual smooth-scroll libraries | The library intercepts `window.scrollTo` and re-animates; direct assignments are reverted on the next animation frame | R2 dispatches the library's immediate API (`window.lenis?.scrollTo(0, { immediate: true })`) via a null-safe in-page adapter list. |
| Scroll position locked (hijacked container, script re-scrolling on reset, cookie interstitial) | Poll would spin forever | R3 hard timeout (1000 ms); safe termination with capture-at-current-offset plus a recorded diagnostic; never a thrown error. |
| Pages already at top (common case: short pages, or reset issued after planner determined zero steps) | Added latency from an unnecessary poll | First poll iteration observes `scrollY === 0` and confirms immediately; total added cost is one evaluate round-trip. |
| Full-page compositing of fixed/sticky elements | Even at `scrollY === 0`, a stale scroll-linked transform (translate applied during the scroll pass and never removed) can displace the navbar | R3's confirmation of `scrollY === 0` is the primary guard; consumers additionally rely on the settle delay (s3.1) before the reset for transform-clean state. Sites whose chrome remains displaced at confirmed-zero scroll are a visual fidelity issue for the evidence review gate, not a reset-contract violation. |
| Style restoration failure (page script mutates inline styles during R1–R4) | Temporary override leaks into the DOM snapshot | R4 restoration is unconditional and best-effort; the captured inline style is cosmetic to tokens (design-token extraction reads computed values), and the leak risk is accepted and documented. |

### 8.5 Test Requirements (additions to s5)

Pure, browser-free units (poll planner with injectable clock/observer; adapter dispatch table) plus executor-level fake-page tests:

| Test | Assertion |
|---|---|
| `reset > smooth scroll is overridden to auto` | The in-page reset source declares `scroll-behavior` with `!important` on both `documentElement` and `body` before any `scrollTo` call (source-order assertion on the evaluated function body), and the executor's fake page records the style override preceding the scroll commands. |
| `reset > zero-scroll position is verified before proceeding` | Given a fake page whose `scrollY` reports 500 for the first two poll observations then 0, the guard confirms after three polls and the executor's operation log places `confirmTop` after the reset commands and strictly before the capture-phase operations; given a page already at 0, exactly one poll observation is made. |
| `reset > timeout guard terminates safely when scroll is locked` | Given a fake page whose `scrollY` never reaches 0 and a clock that advances past the 1000 ms deadline, the guard terminates with `terminatedBy: 'timeout'`, `confirmedTop: false`, the final `scrollY` is surfaced, no error is thrown, and the diagnostic string is produced for the consumer to record. |
| `reset > multi-target reset issues all three scroll paths` | The evaluated reset body contains the `behavior: 'instant'` scrollTo, the `documentElement.scrollTop` assignment, and the `body.scrollTop` assignment. |
| `reset > virtual scroll adapter is null-safe` | The evaluated body dispatches `window.lenis?.scrollTo(0, { immediate: true })` with optional chaining; a fake page without `lenis` completes the reset without error. |
| `reset > style restoration always runs` | The executor removes the temporary `scroll-behavior` override on both the confirmed and timeout paths (fake-page assertion). |

### 8.6 Regression Protection

The existing suites (106 passing tests, including this patch's s5 assertions) must remain green. Specifically:

- The s5.2 executor-ordering test is amended, not invalidated: the operation log's `resetDelay` entry is replaced by `confirmTop` (or the sequence `scrollReset`, `confirmTop`), and the ordering invariant — reset strictly precedes every screenshot/snapshot — is unchanged.
- The s5.1 isolation scan continues to cover every new evaluated body added by this amendment.
- `scroll.test.ts` planner tests (bottom/step/timeout/zero-height termination) are untouched: the amendment changes only the reset phase, not the planner.
- All other suites (`health`, `theme`, `corpus`, `ui`, `gate`, `repair`) are unaffected: they consume persisted evidence or pure helpers, and the amended reset changes no exported signature they depend on.

### 8.7 Acceptance Criteria (Amendment)

The amendment is complete when, re-running the dark-canvas SPA clone end-to-end:

1. The floating navbar rests at the top of every full-page desktop and mobile evidence screenshot, including Gate 1 re-crawls.
2. On a page with `html { scroll-behavior: smooth }`, the reset confirms `scrollY === 0` within the poll window without relying on any fixed latency guess.
3. A page with a locked scroll position still completes its capture with a recorded diagnostic, never a thrown error.
4. No `scroll-behavior` inline style leak appears in captured design tokens or DOM snapshots after restoration.
5. The full unit suite passes with 0 failures: the existing 106 tests plus the new reset assertions.
