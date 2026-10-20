# Apograph — Operational State & Active Run Log

## Configuration
- `TARGET_URL="https://thesyamarcella.pages.dev/"`
- `TARGET_SIMILARITY=85`
- `STATUS`: Transitioning to DOM-grounded structural synthesis.

## Active Engineering Focus
- Removed legacy audit traces and obsolete SDD integration specs.
- Pruning negative-constraint prompt noise in `SYSTEM_GUIDELINES`.
- Shifting visual diff validation to informational reporting.
- **Working-tree state at start (pre-existing work, preserved verbatim):**
  - Modified (unstaged): `package.json` (test registration), `src/cli.ts`
    (compile-heal wiring), `src/crawler/assets.ts` (retry schedule),
    `src/synthesizer/llm.ts` (structured-response failure resilience),
    `src/synthesizer/modular.ts` (data-shape prompt contract),
    `tests/asset-mirror.test.ts`, `tests/llm.test.ts`.
  - Untracked: `docs/experiments/exp-19-10-2026-audit.md` (prior experiment
    log for a different target — historical record), NEW
    `src/synthesizer/compileHeal.ts`, NEW `tests/compile-heal.test.ts`.
  - These are Session-2 remediations (Records #3–#6) from the prior
    experiment (target `beacukai.go.id`, recorded in
    `docs/experiments/exp-19-10-2026-audit.md`). They are treated as frozen
    pre-existing work: preserved, not reverted, not rewritten.

## Existing Experiment History (cross-attempt learning)

`automate-testing-self-fixing.md` did **not** exist at session start, so no
same-log history applies. Per protocol, `docs/experiments/` was inspected
for engine context (targets `mmylana.my.id`, `dci-indonesia.com`,
`beacukai.go.id` — different targets; their generated clones/screenshots
are diagnostic evidence ONLY and are not reused as this run's output,
reference, or acceptance evidence):

- **Confirmed generic engine defects already fixed (present in working
  tree, re-verified before use):**
  - Record #3 — pre-verification compile convergence
    (`src/synthesizer/compileHeal.ts`, wired in `src/cli.ts`): bounded
    2-turn × ≤3-file tsc→repair loop so emitted projects never ship known
    -invalid TypeScript. Regression: `tests/compile-heal.test.ts` (9 tests).
  - Record #4 — data-shape prompt contract
    (`src/synthesizer/modular.ts` `SYSTEM_GUIDELINES` rule 9): typed
    module-level data consts, no inline nested literals in JSX props.
  - Record #5 — longer bounded asset-retry window
    (`src/crawler/assets.ts`): 4 attempts, backoff 1s/3s/8s.
  - Record #6 — structured-response failure resilience
    (`src/synthesizer/llm.ts`): `Invalid JSON response` 2xx bodies →
    bounded transient retry; salvage from `text`/`responseBody`; generateText
    JSON-extraction fallback. Regression: `tests/llm.test.ts` (+6).
- **Known unresolved issues (from prior experiments, re-checked in code):**
  1. No captured `@keyframes`/animation replay in the synthesis pipeline
     (cosmetic; open).
  2. `cloneVerify.ts` aborts the entire live comparison on a single
     navigation timeout and persists no partial report (Category D,
     documented for independent verifier maintenance — NOT to be patched
     as a fidelity change, Rule A).
  3. `fonts.googleapis.com` stylesheet occasionally mis-discovered as an
     image URL (historically harmless).
  4. Model/gateway instability windows (documented twice) can degrade
     synthesis stages to templates; Record #6 is the current mitigation.
- **Prior acceptance lessons:** pixel scores on imagery-less references can
  mask runtime crashes (honesty review required every attempt); template
  fallback output must never be scored as fidelity; per-route fresh
  evidence required every attempt.

## Repository Audit (before Attempt 1)

- **Package scripts:** `pnpm typecheck` (`tsc --noEmit`), `pnpm test`
  (`tsc && node --test tests/<26 files>.test.ts`), `pnpm build` (`tsc` → `dist/`).
- **CLI (`src/cli.ts` → `dist/cli.js`):** verified command surface:
  - `clone <url>`: `--out`, `--evidence`, `--max-depth`, `--max-pages`,
    `--viewport both|desktop|mobile`, `--scope single|subtree|site`,
    `--yes`, `--no-review`, `--force`, `--no-verify`, `--model`,
    `--allow-degraded`, `--live-verify`, `--live-threshold <n>`,
    `--live-retry`. Pipeline: crawl → plan (approval gate) → modular
    synthesize → emit → asset copy → compile-heal (pre-verify) → 3-tier
    verify → optional live clone-verify (retry once when routes fail).
  - `clone-verify <url> <dir>`: side-by-side live comparison (used by
    `--live-verify` internally).
- **Verifier (inspected, NOT modified — Rule A):**
  - 3-tier `src/verifier/engine.ts` → `verification-report.json`: build
    (tsc+vite, bounded repair), route smoke (HTTP/DOM/console), visual
    diff vs stored evidence screenshots (pixelmatch, per-viewport).
  - Live `src/verifier/cloneVerify.ts` → `clone-verify-report.json`:
    boots the clone's Vite dev server, captures original+clone screenshots
    per route, `pixelSimilarity` 0–100 via `compareScreenshots`
    (pixelmatch), plus font/color/animation style reports.
    **Aggregation:** `summary.averageSimilarity` = unweighted mean of
    per-route `pixelSimilarity` (the "overall" score). Pass threshold is
    per route (`--live-threshold`). Route discovery: evidence manifest
    (`.apograph/evidence/manifest.json` relative to cwd or outputDir),
    else generated `App.tsx` routes, else `/`. Viewport: `both` → desktop
    comparison (1280×800); `mobile` → 390×844. Color scheme is emulated
    per route from crawled evidence tokens.
- **Target probe (2026-10-20T05:11Z):** `https://thesyamarcella.pages.dev/`
  HTTP 200 (0.18s). React SPA portfolio ("Thesya Marcella — Software
  Engineer"), Tailwind-based, Google Fonts (Plus Jakarta Sans, Newsreader,
  JetBrains Mono), `/assets/index-*.js` bundle + CSS, favicon/manifest
  assets. Authorized public site; supported class: small SPA site — no
  auth, no robots restrictions observed. Crawl requires JS rendering
  (content is client-mounted), which the Playwright crawler handles.
- **Execution environment:** `APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION=1` set
  for clone runs; `npm_config_cache` pointed inside the workspace
  (`.apograph/npm-cache`) to avoid the historically observed `~/.npm`
  cache EPERM under the file sandbox.
- **Disposable artifacts:** no `.apograph/` or `output/` existed at start —
  every artifact in this session is fresh and isolated per attempt
  (`output/<host>-attempt-N/`, `.apograph/evidence-attempt-N/`).

_(attempt results appended below; earlier entries are immutable)_

### Baseline Validation (working tree, pre-Attempt 1) — UTC 2026-10-20T05:1xZ

- `pnpm typecheck` — **PASS** · `pnpm test` — **PASS 285/285** (21 suites) ·
  `pnpm build` — **PASS** (`dist/` rebuilt from the current working tree).
- Diff fingerprint at start: tracked diff sha256 `65d2e1fb2fb36af5…`;
  untracked `src/synthesizer/compileHeal.ts` `ca97ddf13bec94a7…`,
  `tests/compile-heal.test.ts` `f44c44d7c7465243…`,
  `docs/experiments/exp-19-10-2026-audit.md` `24ff23c3c57184c1…`.
- Pre-existing working tree preserved untouched; all validation runs against
  it as-is (its 285 tests include the prior session's +15 regression tests).

## Attempt 1

- **Attempt:** 1 / 2 · **Started (UTC):** 2026-10-20T05:15Z
- **Source revision:** baseline `7d7b93e` + pre-existing uncommitted
  remediations (fingerprint above) + freshly rebuilt `dist/`.
- **Clean run (Step 1):** no prior `.apograph/` or `output/` existed; fresh
  evidence dir `.apograph/evidence/`; isolated output
  `output/thesyamarcella-pages-dev-attempt-1/`. Fresh clone and fresh
  verification evidence for this attempt (no historical reuse).
- **Clone command (Step 3):**
  `export APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION=1; node dist/cli.js clone https://thesyamarcella.pages.dev/ --max-depth 2 --max-pages 3 --scope site --viewport both --live-verify --live-threshold 85 --live-retry --yes --no-review -o output/thesyamarcella-pages-dev-attempt-1 -e .apograph/evidence`
  (plus `npm_config_cache=$PWD/.apograph/npm-cache` to keep npm writes
  inside the workspace per the historical sandbox note).
- **Startup note (transparent record):** the first launch of the Attempt-1
  command aborted before producing any crawl output because its `tee` log
  sink failed (`.apograph/` did not yet exist). The stalled process tree was
  stopped, its partial `.apograph/evidence/` removed, and the identical
  command relaunched at 2026-10-20T05:17Z with a valid log sink
  (`.apograph/attempt-1-run.log`). No score or evidence was produced by the
  aborted launch; Attempt 1's evidence is exclusively from the relaunch.

### Attempt 1 — Results (UTC 2026-10-20T05:17Z → 05:56Z)

- **Routes captured:** 1/1 (`/` — the target is a scroll-based single-page
  portfolio; crawl strips fragments, Gate 1 confirmed 1 active route).
  Desktop + mobile evidence captured. Assets discovered/mirrored: see
  diagnosis (evidence `assets.json` = 0 entries — investigated below).
- **Synthesis:** 2 stage(s) via vision LLM, 0 deterministic fallbacks —
  genuine synthesis (run status: success, no `DEGRADED CLONE` banner).
  Palette snap pinned 6 color literals to captured evidence colors.
- **compile-heal (pre-existing Record #3):** installed deps; emitted project
  typechecked cleanly before verification (0 repair turns needed).
- **3-tier verification (`verification-report.json`): Overall PASS** —
  build tsc+vite PASS; route `/` HTTP 200, DOM loaded, 0 console errors,
  0 exceptions; visuals: desktop mismatch 5.1%, mobile mismatch 12.6%
  (mobile repaired 22.1% → 12.6% by the verifier's own bounded keep/revert
  visual repair pass — frozen methodology, unchanged).
- **Live clone-verify (`clone-verify-report.json`, desktop 1280×800):**
  - `/` pixel similarity **94.923%** (≥ 85 → PASS), fonts 15/3 matched,
    colors 2/2 matched, animations `ping, pulse` present in original only.
  - **Overall (mean of per-route pixel similarity): 94.923%** =
    `summary.averageSimilarity` (unweighted mean across routes;
    1 route here). Aggregation unchanged from documented methodology.

### Attempt 1 — Honesty review (mandatory)

- **Score reproducibility:** independently re-ran pixelmatch
  (threshold 0.1, alpha normalized) on
  `original-index-desktop.png` vs `cloned-index-desktop.png`:
  mismatch 5.077% → similarity **94.923%** — byte-exact match with the
  report. The measurement is genuine, not fabricated.
- **PNG statistics (both sides real content):** reference 53.1% non-white /
  4097 colors; clone 26.8% non-white / 2534 colors — both render real
  content (not blank-page coincidence). A stricter per-channel metric
  (>24/channel) shows 73.5% similarity with differences concentrated in
  content bands (10–41% per band) — the pixelmatch YIQ metric is more
  forgiving; the frozen methodology is used for scoring and is reported
  alongside this caveat.
- **Structural content:** full-page diagnostic capture (clone 3418px vs
  reference 3141px) shows all 5 major sections present
  (overview / experience / projects / deep-dive / writing) with real text
  content matching the reference text-spans (217 spans); band differences
  6–17% mid-page, 25–29% near the bottom (clone runs 277px taller).
  Not reused as score evidence — diagnostic only.
- **Runtime/functional smoke (diagnostic):** expand-all accordion works
  (scrollHeight 3418→4298), buttons responsive, **0 console errors,
  0 exceptions**.
- **Defects found behind the passing score (see diagnosis):**
  1. External profile links use generic destinations
     (`https://github.com/`, `https://www.linkedin.com/`) instead of the
     target's real profile URLs — broken navigation content.
  2. `/resume.pdf` link exists in clone nav but no `resume.pdf` asset is
     emitted (public/ is empty) → 404 on click (target serves 200).
  3. Webfonts "Plus Jakarta Sans" / "JetBrains Mono" / "Newsreader" are
     **missing from the clone's computed styles** (evidence captured the
     computed stacks but no `@font-face`/font-stylesheet replay exists);
     index.html hotlinks the live site's favicon.
  4. `fontMatchScore: 500%` — impossible value; verifier aggregation mixes
     split family-name counts (matched) against raw stack counts
     (original) in `coveragePercent` (Category D — documented, NOT
     patched, Rule A).

### Attempt 1 — Decision (Step 5)

**NOT accepted as successful** despite 94.9% ≥ 85: mandatory functional
integrity checks fail (broken external navigation targets, 404 resume
asset). Per Section 5: "A high pixel score does not excuse missing
functionality or broken navigation." Proceeding to evidence-based
remediation and Attempt 2 within the remaining budget.

### Diagnosis (Attempt 1 → root causes, all verified against evidence)

**D1 — Broken external navigation targets (Category A, confidence: high).**
Clone emitted `https://github.com/` and `https://www.linkedin.com/`
homepages where the target uses profile URLs
(`github.com/thesyamarcella`, `linkedin.com/in/thesyamarcella`).
Reproduction: `output/thesyamarcella-pages-dev-attempt-1/src/pages/HomePage.tsx`
href grep vs target bundle constants. Root cause: the text-span evidence
carries text/style/geometry but NO anchor href (`src/types.ts` TextSpan had
no href field), so the synthesizer had zero link-target evidence and the
prompt contract never addressed links — the model invented generic URLs.

**D2 — Invented dead `/resume.pdf` link (Category A/C, confidence: high).**
The target's "RESUME.PDF" control is a BUTTON that opens a resume modal
(`fixed inset-0 z-50` overlay containing `window.print()`); the clone
invented `<a href="/resume.pdf">` (404). Two verified root causes:
  a. The interactive-state probe's overlay heuristic demanded
     `position: fixed && z-index > 100`; the target's modal is `z-50`
     (the conventional Tailwind dialog band). Live probe against the
     target (2026-10-20T06:0xZ) confirmed: after clicking the resume
     button, strict selector matches = 0 and the only new layer is
     `fixed inset-0 z-50` — invisible to the old heuristic.
     Hence `modalCaptures: null` in evidence and no modal instruction.
  b. Even when captured, modal screenshots were loaded nowhere in
     synthesis (`loadRouteScreenshots` reads only route shots) — the
     stage-3 prompt got a text line but no overlay imagery.

**D3 — Webfont replay gap (Category A, confidence: high).**
`fontReport.missing` = plus jakarta sans, jetbrains mono. The target loads
its fonts from `fonts.googleapis.com` (cross-origin stylesheet);
`collectCssText` skips cross-origin `cssRules` (throws), and no fallback
existed → `fontFaces: null` in evidence → generated index.css carried
`--font-apograph-N` family names but no `@font-face`/font stacks on the
theme → computed styles fell back to system fonts. (Known historical gap
#3 from prior experiments, now root-caused precisely.)

**D4 — `fontMatchScore: 500%` aggregation anomaly (Category D).**
`cloneVerify.ts` computes `coveragePercent(matched.length, original.length)`
where `matched` is a list of split family NAMES (15) and `original` is the
list of raw font STACKS (3) — mixing units inflates the ratio (15/3 = 500%).
**Documented only — NOT patched (Rule A: verifier maintenance is out of
scope for fidelity work).** The pixel similarity (the acceptance metric)
is unaffected and independently reproduced.

### Remediation record (applied before Attempt 2)

**Record #7 — anchor-href evidence capture + link-target prompt contract**
(Category A/B, generic)
- Files: `src/types.ts` (TextSpan.href), `src/harvester/dom.ts`
  (RawTextSpan.href + self-contained `anchorHref` collector in
  `collectRawTextSpans`; `buildTextSpans` propagates verbatim hrefs and
  omits the key for unlinked spans), `src/synthesizer/vision.ts`
  (`formatTextSpansForPrompt` renders `[link: <href>]` markers + corpus
  header states the never-invent contract), `src/synthesizer/modular.ts`
  (SYSTEM_GUIDELINES LINK TARGETS rule: reproduce captured hrefs verbatim;
  unmarked spans are plain text/buttons — never invent destinations).
- Why general-purpose: any site's link corpus; evidence-driven, no
  hardcoded URLs. Buttons stay buttons; only captured anchors become <a>.
- Regression: `tests/link-evidence.test.ts` (href passthrough incl.
  mailto:, absent-key for unlinked spans, prompt markers, contract text).

**Record #8 — cross-origin webfont stylesheet mining** (Category A, generic)
- Files: `src/harvester/dom.ts` (`collectUnreadableStylesheetHrefs`
  in-page collector; pure exported `mergeFontTokens` first-wins merge;
  `extractDesignTokens` mines remote stylesheet text via injectable
  `fetchStylesheetText` — default is `fetchStylesheetText`, bounded at 5
  sheets / 512 KiB / 10 s and SSRF-policy-checked through
  `validateNetworkUrl`; `captureDOMSnapshot` passes options through).
- Why general-purpose: any CDN-hosted webfont (Google Fonts, Typekit…);
  the captured `@font-face` rules replay through the EXISTING
  `generateIndexCss` font-replay machinery (no new emit paths). Every
  fetch passes the same public-web policy as asset mirroring (Rule F).
- Regression: `tests/link-evidence.test.ts` (merge dedupe, fetcher
  injection, failure tolerance + cap enforcement); `tests/scroll.test.ts`
  self-containment list extended to the new in-page collector (guard
  STRENGTHENED — no assertion weakened).

**Record #9 — conventional dialog-band overlay detection + modal imagery
in synthesis** (Category A/B, generic)
- Files: `src/crawler/interactions.ts` (fixed-layer heuristic: z-index
  >= 30 OR covers >= 60% of viewport, replacing z-index > 100; docs
  updated), `src/synthesizer/vision.ts` (new
  `loadModalCaptureScreenshots` loads ModalCapture desktop/mobile PNGs),
  `src/synthesizer/modular.ts` (stage-3 appends modal screenshots after
  route screenshots; `modalCapturePromptLines` now tells the model the
  trigger is a BUTTON opening an overlay in-place — never an <a href>).
- Why generic: z-50 is the standard dialog band across CSS frameworks;
  the before/after marker diff keeps pre-existing fixed chrome excluded.
- Regression: `tests/link-evidence.test.ts` (source invariants for the new
  heuristic + before/after marking contract).

**Record #10 — measured font-family in prompt metrics** (Category B, generic)
- Files: `src/synthesizer/vision.ts` (`formatMeasuredMetrics` surfaces
  `family <name>` — the computed family already captured in TextStyle but
  never shown; measured-metrics legend updated).
- Why generic: per-span computed family is rendered ground truth for any
  site; the model can now apply it via arbitrary font utilities.
- Regression: asserted in `tests/link-evidence.test.ts`.

### Regression validation (post-Records #7–#10, pre-Attempt 2)

- `pnpm typecheck` PASS · `pnpm test` PASS **297/297** (285 + 12 new) ·
  `pnpm build` PASS · `git diff --check` clean.
- Rule A: `src/verifier/` diff empty ✓. Test-file changes are
  strengthening only (`tests/scroll.test.ts` adds a collector to the
  self-containment guard; `tests/link-evidence.test.ts` is new; the
  `tests/asset-mirror.test.ts`/`tests/llm.test.ts` diffs are the
  pre-existing Session-2 work — untouched). No assertion weakened,
  no fixture altered.
- Rule B: no target strings in `src/` (scan exit 1 = clean) ✓.
- Rule C: no runtime forcing in generated output ✓ (all fixes are
  build-time evidence/prompt/emit work).
- Cross-target validation: fixtures are generic (example.com hrefs,
  generic CSS @font-face, generic dialog markup). Second live-site
  validation unavailable this session (reported per Section 7).

## Attempt 2

- **Attempt:** 2 / 2 · **Started (UTC):** 2026-10-20T06:2xZ
- **Source revision:** baseline `7d7b93e` + pre-existing remediations +
  Records #7–#10 (diff fingerprint recomputed at completion).
- **Clean run (Step 1):** Attempt-1 evidence archived to
  `.apograph/evidence-attempt-1/`; fresh `.apograph/evidence/`; isolated
  output `output/thesyamarcella-pages-dev-attempt-2/`. Fresh clone and
  fresh verification evidence throughout.
- **Validation (Step 2):** typecheck PASS / 297/297 / build PASS (above).
- **Clone command (Step 3):** identical to Attempt 1 except `-o
  output/thesyamarcella-pages-dev-attempt-2`.

### Attempt 2 — Results, run 1 (UTC 2026-10-20T~06:3xZ → 10:12Z): INCOMPLETE (infrastructure)

- **Routes captured:** 1/1 (`/`), desktop + mobile. **Synthesis: 2 stage(s)
  via vision LLM, 0 fallbacks** — genuine. compile-heal: typechecks cleanly.
- **3-tier verification (`verification-report.run1-interrupted.json`,
  preserved verbatim):** build PASS, route `/` PASS (0 console errors,
  0 exceptions), visuals desktop 5.6% PASS / **mobile 22.2% FAIL**.
- **Infrastructure failure evidence (verbatim):** the live clone-verify
  died with `net::ERR_INTERNET_DISCONNECTED` at the target — a transient
  machine-wide network outage (target probed HTTP 200 again minutes later
  at 10:2xZ). The same outage window silently no-op'd the verifier's
  visual-repair pass: `runVisualRepairPass` swallows its repair-turn
  failure (`catch { break; }` around `repairComponent`), so the report
  carries NO `repairs` field at all — in Attempt 1 the identical code path
  repaired mobile 22.1% → 12.6%. Attempt 2's raw mobile (22.2%) is
  statistically the same raw value as Attempt 1's raw (22.1%); what's
  missing is the repair turn, not quality. (Category D observation: the
  silent catch hides infrastructure failure as "no repairs needed" —
  documented, verifier not patched.)
- **Why INCOMPLETE, not a completed attempt:** no machine-readable live
  comparison report exists (`clone-verify-report.json` absent), and the
  3-tier run's repair tier was defeated by the outage. Per Section 8 a
  completed attempt requires its clone AND verification to actually run;
  this run's verification did not complete. N_INPUT accounting: Attempt 1
  completed (FAILED verdict) + this INCOMPLETE run — budget NOT exhausted
  by the rule "never claim the attempt budget was exhausted when it was
  not"; one completion retry is authorized (hard-capped at one).
- **Fixes verified present in the attempt-2 generated code (fresh clone,
  retained):** real hrefs `https://github.com/thesyamarcella`,
  `https://linkedin.com/in/thesyamarcella`, `mailto:thesyamarcella@gmail.com`
  (Record #7 — no invented `/resume.pdf` link anywhere); `@font-face`
  replay for Plus Jakarta Sans / JetBrains Mono / Newsreader with
  `font-[family-name:...]` measured-family utilities (Records #8, #10);
  resume modal as `useState` + `window.print()` overlay (Records #9 —
  `modalCaptures` this time contains the "Thesya Marcella" resume modal
  triggered by the RESUME.PDF button, proving the z-50 heuristic fix).

### Attempt 2 — Completion retry (verification-only, same fresh clone)

The clone output of Attempt 2 is fresh and unchanged; the outage only
destroyed its verification runs. The completion retry therefore re-runs
the frozen verification methodology (3-tier `verify` incl. its normal
repair pass, then live `clone-verify`) against this attempt's own output —
no historical artifacts reused, no methodology changed. Run 1's report is
preserved above; both results will be reported.
- **Note on the first completion-retry invocation:** the foreground `verify`
  re-run was killed at its 600 s harness timeout mid-repair-LLM-call.
  Verified afterwards that NO half-applied mutation landed (`HomePage.tsx`
  mtime unchanged, still the emit-time write; no stray vite/tsc/node
  processes; run-1 report preserved). The retry was relaunched as a
  managed background job (`.apograph/attempt-2-verify-retry.log`).
