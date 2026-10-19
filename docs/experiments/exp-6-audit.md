# Apograph — Autonomous Clone Verification, Diagnosis & Self-Healing Protocol

## Configuration (Experiment 6 — new target)

```text
TARGET_URL="https://dci-indonesia.com/"
TARGET_SIMILARITY=85
N_INPUT=3
LOG_FILE="automate-testing-self-fixing.md"
```

## Experiment initialization

- UTC start timestamp (actual `date -u` at log creation): `2026-10-19T08:46:58Z`
- Baseline commit: `902b2a33fad71829a77c9a9cff8e37fb7036777e` (`fix(synthesizer): remove target-specific geometry-replay overrides and audit history`)
- Branch: `main` (no remote operations performed).

### Pre-existing working-tree state (baseline, preserved throughout)

```text
git status --porcelain:  (empty — clean tree)
```

- The tree is clean at baseline. Prior experiment work (remediations #1–#13) is **committed** in `42d7ce9 feat(engine): visual fidelity and capture resilience remediations (#1-#13)` and `902b2a3` (which removed the former `src/synthesizer/geometryReplay.ts` runtime emitter and its tests).
- The prior audit history is preserved at `docs/experiments/exp-1-to-5-audit.md` (archived from earlier rounds by the operator). This log is a fresh record per protocol Section 4 (the previous `automate-testing-self-fixing.md` no longer exists on disk; nothing is invented here — prior scores live on in the archive and the git record).
- Changes created by THIS experiment are listed per remediation record and appear as unstaged working-tree edits; nothing is committed, staged, amended, or reverted.

## Repository audit (before Attempt 1)

- Package scripts: `pnpm typecheck` (=`tsc --noEmit`), `pnpm test` (=`tsc && node --test tests/*.test.ts` list, 20 files), `pnpm build` (=`tsc`).
- CLI (`dist/cli.js`, source `src/cli.ts`) — command surface re-verified this round:
  - `clone <url>`: `-o/--out`, `-e/--evidence`, `--max-depth`, `--max-pages`, `--viewport both|desktop|mobile`, `--scope single|subtree|site`, `--yes`, `--no-review`, `--force`, `--no-verify`, `--live-verify`, `--live-threshold <n>`, `--live-retry`, `--allow-degraded`.
  - `clone-verify <url> <outputDir> --threshold <n> --port <n> --viewport <mode>`: live original-vs-clone pixel comparison; writes `<outputDir>/clone-verify-report.json`.
  - `verify <outputDir> <evidenceDir>`: 3-tier verification (build + route smoke + visual diff vs evidence screenshots) → `<outputDir>/verification-report.json`.
- Verifier identification (read-only inspection; `git diff HEAD -- src/verifier/` = 0 lines):
  - 3-tier (`src/verifier/engine.ts`): per-route references = the crawl's `desktopScreenshot`/`mobileScreenshot` from the evidence bundle; viewports 1280x800 desktop / 390x844 mobile; pass when pixelmatch `mismatchPercent` < 15 (threshold fixed — never changed).
  - Live (`src/verifier/cloneVerify.ts`): boots the emitted project's dev server, drives two Chromium instances (live original vs local clone); per-route pixel similarity = `100 − mismatchPercent`; `averageSimilarity` = arithmetic mean over routes. With `--viewport both` the live comparison uses the desktop viewport only (documented limitation); live mobile coverage is obtained by an additional standalone `clone-verify --viewport mobile` run as supplementary evidence.
- Clean/build/clone/verify commands confirmed from `package.json` and `src/cli.ts`.
- Target reachability: `https://dci-indonesia.com/` returns HTTP 200 (Next.js SSR; `Hanken Grotesk` font variables; Cloudfront media libraries). Authorization taken from the operator-supplied configuration (Section 2: "any authorized, publicly accessible website").
- Environment: Node 24.16.0; Playwright Chromium available (validated in prior rounds via `apograph doctor`). Known environment remediation (from prior rounds, still required): package-manager cache redirection (`npm_config_cache` / `npm_config_logs_dir` → workspace `.apograph/runs/cache/`) because the session file sandbox denies cache writes outside the workspace.
- `src/verifier/` is read-only for this experiment (Rule A). Shared source must stay target-agnostic (Rule B): grep over `src/` confirms no site name, route name, or theme string (matches only generic identifiers such as `VISION_PRESETS`).
- Attempt evidence will live in isolated per-attempt run directories `.apograph/runs/exp6-attempt-N/` so no screenshot or report can be mistaken for a current result. Historical runs under `.apograph/runs/` (previous target) are diagnostic-only.

## Rule C compliance audit (before Attempt 1) — runtime layout forcing removed

The new protocol's Rule C bans runtime helpers in **emitted projects** (MutationObservers, window listeners, geometry/coordinate replays, margin nudging, client-side DOM text rewriting) and requires build-time fidelity through semantic JSX + Tailwind utilities.

- **State of the baseline (verified by inspection + grep)**: `902b2a3` already removed `src/synthesizer/geometryReplay.ts` (the runtime replay generator from earlier remediations #7/#9/#11/#13) and `tests/geometry-replay.test.ts`, and `src/synthesizer/modular.ts` no longer emits or installs any replay module (`generateMainTsx()` takes no replay flag). A scan of all generator code (`src/synthesizer/*`, `src/emitter/*`) finds **zero** `MutationObserver`/`addEventListener`/`setInterval`/`requestAnimationFrame` emissions (the only `setTimeout` is the engine-side LLM retry sleep in `llm.ts`, never emitted).
- **Residual prompt-contract issue found (this experiment's change, remediation record #14 below)**: the stage-2/stage-3 synthesis prompts still instructed the model to "constrain container widths, column insets, and vertical spacing to the measured box geometry" and reproduce "box widths exactly" — pixel-box pinning guidance that conflicts with Rule C's requirement that layout fidelity come from proper flexbox/grid structure. Corrected to build-time semantic-layout guidance.
- **Build-time mechanisms retained (Rule C compliant)**: measured type-scale/typography metrics in prompts (design evidence), webfont replay in generated `index.css`, captured-palette color normalization at source-emit time (`paletteSnap.ts` rewrites generated TSX/CSS source before output — no runtime code), canvas overlay asset capture + prompt contract, bundle-relative evidence references. None of these emit client-side helpers.

## Diagnosis — remediation record #14 (prompt contract: semantic layout over pixel-box pinning)

- **Observed failure**: synthesis prompts (stage-2 MEASURED GEOMETRY note; stage-3 MEASURED GEOMETRY CONTRACT) instructed exact box-width/box-geometry pinning of text elements, which under Rule C steers the generator toward brittle pixel forcing instead of semantic layout.
- **Reproduction evidence**: `src/synthesizer/modular.ts` prompt lines ("constrain container widths, column insets, and vertical spacing to the measured box geometry"; "box widths exactly (arbitrary Tailwind values)").
- **Root cause & confidence**: the clauses were written for the former runtime-replay architecture and were not revised when that architecture was removed. Confidence: **high** (direct source inspection).
- **Failure category**: B (general-purpose prompt-contract defect).
- **Fix — exact source files changed** (`src/verifier/` untouched):
  - `src/synthesizer/modular.ts`: both prompts now mandate exact measured TYPE SCALE (font sizes/weights/line-heights/letter-spacing via arbitrary Tailwind values) and require the measured spacing rhythm, column insets, and section flow to emerge from proper semantic flexbox/grid containers and standard Tailwind utilities — explicitly forbidding fixed pixel widths, forced nowrap, absolute coordinates, or runtime nudging on text elements.
- **Why general-purpose**: the contract is about HOW any target's layout is produced (semantic structure), not about any site's values; measured metrics remain evidence-driven per run.
- **Regression tests**: full suite (`pnpm test`) re-run green (240/240) with the corrected contract; `tests/geometry-evidence.test.ts` source invariants (both stages embed the mobile corpus + a measured-geometry contract) remain satisfied. An explicit "no runtime helpers in emitted projects" regression test is noted as follow-up coverage (the current generator surface is verified by the grep audit above).
- **Expected impact & potential regressions**: emitted projects are clean, maintainable React/Tailwind per Rule C; layout accuracy now depends on prompt-driven structure (may score slightly lower than the former runtime forcing — explicitly acceptable per Rule A: "an honest 75% score on clean, functional HTML/CSS is strictly required over an 85%+ score achieved by brittle layout forcing").
- Cross-target validation: the suite uses generic fixtures; this round's target is itself a second, materially different site (Next.js SSR site vs the previous Angular SPA).

## Experiment-6 integrity attestation (pre-attempt)

- `src/verifier/` untouched (0 diff lines). No thresholds, scoring, aggregation, fixtures, or assertions changed. No reference screenshots/expected scores/reports generated or edited. No stale artifacts will be reused — every attempt uses an isolated run directory with a fresh crawl/synthesis/capture.
- Target similarity 85; attempt budget N_INPUT=3 (not to be extended).

## Exp6 Attempt 1 (Run 1) — full clone-and-verify — FAILED (single route; visuals far below target)

UTC window: `2026-10-19T08:52Z` → `2026-10-19T09:04:32Z` (3-tier report `2026-10-19T09:04:32.051Z`; live comparison aborted). Run directory: `.apograph/runs/exp6-attempt-1/` (fully fresh; isolated cwd). Source: `902b2a3` + remediation #14 prompt edits + the round's test additions. Completed attempts: 1 / 3.

### Step 2 — Source validation

- `pnpm typecheck` 0 · `pnpm test` 243/243 (then; suite now 252/252 after #15/#16 tests) · `pnpm build` 0 · `git diff --check` clean · `src/verifier/` diff = 0.

### Step 3 — Fresh clone

- Effective command (cwd = `.apograph/runs/exp6-attempt-1`, env `APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION=1` + npm cache redirection):

```bash
node /Users/hikari/lana/apograph/dist/cli.js clone https://dci-indonesia.com/ \
  --max-depth 2 --max-pages 3 --scope site --viewport both \
  --live-verify --live-threshold 85 --live-retry --yes --no-review
```

- Exit code 1. **Routes captured: 1 of 3** (`/` only). Crawl diagnostics (machine-readable, `manifest.json`): `failedNavigations` — `/about-us` and `/why-dci` both dropped with `page.goto: Timeout 30000ms exceeded … waiting until "networkidle"`; capture-state reload timed out the same way ("post-reload navigation incomplete … capture proceeded"); post-scroll readiness incomplete ("images (capped at: images)").
- Assets: 15 discovered / 13 downloaded / 1 failed / 1 external — **only logos and icons; none of the site's content imagery** (hero photo, partner logos, media-library JPGs on `d2gr9f68xie3i0.cloudfront.net` were never discovered — the DOM at discovery time was a half-loaded document after the timed-out reload).
- Synthesis: 2 vision stages, 0 fallbacks; palette snap pinned 8 literals. Output: `output/dci-indonesia-com/` (15 files).

### Step 4 — Verification results (machine-readable)

- 3-tier (`verification-report.json`, `2026-10-19T09:04:32.051Z`): build **PASS**, routes **PASS** (`/` HTTP 200, 0 console errors). Visuals **FAIL**:

| Route | Desktop mismatch | Mobile mismatch | vs 15% gate |
|---|---|---|---|
| `/` | **84.6%** | **69.5%** | **FAIL** |

- Repair loop engaged (4 bounded turns): desktop 88.7% → 84.6% (kept), mobile 73.3% → 69.5% (kept), then two no-op turns reverted. Far above threshold regardless.
- Live comparison **could not run**: `page.goto: Timeout 30000ms exceeded … waiting until "networkidle"` on the original site (the live verifier's own navigation; see Category D below). No `clone-verify-report.json` was produced. Exit code 1.
- Diff-band localization (desktop): 62–99% mismatch in every 100-row band of the first viewport — the clone approximated the photographic hero with CSS gradients and had no real images to render.

### Step 5 — Decision

**FAILED** (completed attempt). The clone diverges massively (evidence-equivalent similarity ≈ 15.4% desktop / 30.5% mobile) and only 1 of 3 routes was even captured. Diagnosis below → remediations #15/#16 → Attempt 2.

### Diagnosis — remediation record #15 (cross-origin image mirroring)

- **Observed failure**: the mirrored asset set contained only same-origin logos/icons — none of the target's CDN-hosted content imagery, so the synthesized page had to approximate photographs with CSS (the dominant cause of the 84.6%/69.5% mismatch).
- **Reproduction evidence**: `manifest.json` asset list + `uncapturedResources` (the Cloudfront URLs are absent entirely); `src/crawler/assets.ts` `mirrorAssets` recorded cross-origin URLs as `external` and **never downloaded them** (`url.origin !== rootOrigin → continue`) — even though everything reaching that function is an image the page actually renders.
- **Root cause & confidence**: the asset mirror was same-origin-only, so any CDN-hosted site (Cloudfront/S3/imgix/Unsplash — extremely common) lost its content imagery. Confidence: **high** (code + manifest evidence).
- **Failure category**: A (general-purpose asset pipeline — "broken asset discovery or downloads").
- **Fix — exact source files changed** (`src/verifier/` untouched):
  - `src/crawler/assets.ts`: cross-origin images are mirrored through the same validated download path (SSRF/network policy per request, `image/*` MIME check, per-asset and total byte budgets); redirect targets may now be cross-origin (CDN → object storage) as long as they pass the network policy (previously thrown out); failure diagnostics carry same-origin/cross-origin provenance.
- **Why general-purpose**: mirrors whatever images a site actually renders, from whatever origin; security controls are unchanged (policy + budgets still gate every request). Tests use `example.com`/`cdn.example.org` fixtures only.
- **Regression tests added**: `tests/asset-mirror.test.ts` — 4 tests (cross-origin + same-origin mirrored; policy-blocked and non-image fail without weakening SSRF; policy-valid cross-origin redirect followed; byte limits enforced). Suite 252/252 green.
- **Expected impact & potential regressions**: generated clones can finally render CDN-hosted content imagery. Risks checked: byte budgets bound abuse; non-image content rejected; SSRF unchanged (validated for every request incl. redirects).

### Diagnosis — remediation record #16 (resilient navigation readiness)

- **Observed failure**: hard `waitUntil: 'networkidle'` navigations time out on this target (persistent connections) — two routes were dropped entirely, capture-state reloads left a half-loaded document for asset discovery, and the live comparison aborted (diagnostics above; also reproduces standalone: the site reaches networkidle only after >30s or never).
- **Reproduction evidence**: `manifest.json` `failedNavigations` + `skippedUrls` entries (all `networkidle` timeouts); sequence probe (`.apograph/runs/analysis/asset-sequence-probe.mjs`) shows the SAME discovery finds 51 URLs / 28 content images at every step when navigation is allowed to settle.
- **Root cause & confidence**: readiness model treats idle-wait timeout as navigation failure. Confidence: **high** (deterministic from diagnostics + probe).
- **Failure category**: A (crawler readiness) with a Category D verifier-side residual (below).
- **Fix — exact source files changed** (`src/verifier/` untouched):
  - `src/crawler/navigation.ts` (NEW): `gotoWithReadiness` / `reloadWithReadiness` — prefer `networkidle`, but a timeout on a *committed* navigation degrades to an explicit `settled: false` outcome with a settle delay + diagnostic note; genuine failures (no committed navigation, connection refused) still throw.
  - `src/crawler/engine.ts`: route navigation and capture-state reloads use the helper; a degraded settle is recorded via the existing diagnostics channel (`skippedUrls` note) and capture proceeds through the existing readiness passes instead of dropping the route.
  - `src/plan/evidenceGate.ts`: `recrawlRoute` navigation uses the same helper.
- **Why general-purpose**: correct behavior for ANY site whose connections never idle (analytics, websockets, streaming); sites that settle normally behave exactly as before.
- **Regression tests added**: `tests/navigation-readiness.test.ts` — 5 tests (clean settle; committed-navigation timeout degrades with note; uncommitted timeout throws; real failures throw; reload semantics). `tests/capture-state.test.ts` invariant updated to the equivalent reload mechanism (the reload intent is unchanged). Suite 252/252 green (`pnpm typecheck` 0, `pnpm build` 0, `git diff --check` clean, `src/verifier/` diff = 0 lines).
- **Expected impact & potential regressions**: routes no longer dropped to idle-timeouts; asset discovery runs on settled documents; recrawls survive idle-heavy sites. Risks checked: real navigation failures still fail loudly; degraded settles are always recorded as diagnostics (never silent).

### Category D documentation (verifier maintenance, NOT patched — Rule A)

- **Defect**: `src/verifier/cloneVerify.ts navigateBoth()` navigates the original with `waitUntil: 'networkidle'` and a 30s timeout; on idle-heavy sites the live comparison aborts before any capture (`page.goto: Timeout 30000ms exceeded`).
- **Impact**: the live original-vs-clone methodology cannot run against such targets; the 3-tier evidence comparison remains valid and independent.
- **Required independent maintenance**: adopt the crawler's resilient navigation semantics (`src/crawler/navigation.ts`) in the verifier's navigation path; distinguish "navigation failed" from "idle did not settle". No scoring change is implied.

## Attempt-2 pre-run state

- Validation re-run before Attempt 2: `pnpm typecheck` 0 · `pnpm test` **252/252** · `pnpm build` 0 · `git diff --check` clean · `src/verifier/` diff = 0 · no target-specific strings in the shared diff.

## Exp6 Attempt 2 (Run 2) — full clone-and-verify — FAILED (`/` and `/about-us` below target; `/why-dci` passes)

UTC window: `2026-10-19T10:54Z` → `2026-10-19T11:19:34Z` (3-tier report `2026-10-19T11:18:47.821Z`; live reports `11:19:11.302Z` and retry `11:19:34.460Z`). Run directory: `.apograph/runs/exp6-attempt-2/` (fully fresh). Source: `902b2a3` + remediation #14 prompt edits + remediations #15/#16 + round tests. Completed attempts: 2 / 3.

### Step 2 — Source validation

- `pnpm typecheck` 0 · `pnpm test` 252/252 · `pnpm build` 0 · `git diff --check` clean · `src/verifier/` diff = 0.

### Step 3 — Fresh clone

- Same effective command/config (methodology frozen) + remediated env; exit code 1 (visuals below threshold). **Routes captured: 3 of 3** (`/`, `/about-us`, `/why-dci`) — remediation #16 confirmed live: the two routes dropped by idle-timeouts in Attempt 1 were captured; `failedNavigations: 0`. Assets: 18/18 downloaded (0 failed, 0 external) — remediation #15 confirmed live (previously `bg-frostBlue.png` failed and the gstatic recaptcha logo was skipped as external). Synthesis: 4 vision stages, 0 fallbacks. Output: `output/dci-indonesia-com/` (14 files). Live comparison ran to completion this round (the verifier's `networkidle` navigation settled within its timeout; see Category D note — unchanged code, this is site/timing-dependent).

### Step 4 — Verification results (machine-readable)

- 3-tier (`verification-report.json`, `2026-10-19T11:18:47.821Z`): build **PASS**, routes **PASS** (3/3, 0 console errors/exceptions). Visuals:

| Route | Desktop mismatch | Mobile mismatch | vs 15% gate |
|---|---|---|---|
| `/` | **89.2%** | **74.6%** | **FAIL** |
| `/about-us` | **46.3%** | **58.6%** | **FAIL** |
| `/why-dci` | 9.3% | 10.6% | **PASS** |

- Visual repair loop (7 records): `/` desktop 92.2→89.2 (kept), `/` mobile 82.6→74.6 (kept), `/about-us` desktop 46.3→53.7 and mobile 58.6→63.5 (regressions, reverted), `/why-dci` mobile **23.3→10.6 [FIXED]**.
- Live comparison (`clone-verify-report.json`, retries in `clone-verify-attempt-*.json`): `/` **10.8%**, `/about-us` **53.7%**, `/why-dci` **90.7%** — mean 51.7%, 1/3 routes ≥ 85. Both live runs identical (deterministic).

### Step 5 — Decision

**FAILED** (completed attempt). One attempt remains → diagnosis below → remediation #17 → final attempt.

### Diagnosis — remediation record #17 (interactive probing pollutes downstream evidence passes)

- **Observed failure**: `/` (and partially `/about-us`) synthesize photographic hero regions as CSS gradients — the CDN-hosted content imagery (Cloudfront `uploads/media_libraries/*` hero photos, partner logos) never appears in the manifest asset list, on ANY route, despite the crawl's own reference screenshots showing the photos (reference-vs-live hero pixelmatch = **0.0%** — the reference is faithful). The clone's hero is a smooth gradient (block-variance 8.9% vs 25.4% photographic), producing 89.2%/74.6% mismatch and 10.8% live similarity on `/`. `/why-dci` passes precisely because its hero qualified for the visual-extract fallback (`hero-bg` crop) while `/`'s `<img>` hero did not (http(s) `<img>` srcs are the DOM mirror's responsibility by design).
- **Reproduction evidence** (probes under `.apograph/runs/analysis/`):
  1. Standalone `discoverImageAssets` finds **51 URLs (28 content images)** at every stage of the crawl sequence (goto → autoscroll → mobile reload → desktop restore → hash scrolls) and at every delay (0–60s idle; DOM keeps 68 `<img>` nodes) — timing, reloads, storage clears, and screenshots are all exonerated.
  2. The real CLI `crawl` command reproduces the loss deterministically: `crawl-diag` manifest = 18 assets, **0 cloudfront** (three runs: attempts 1–2 + diag crawl).
  3. **The interaction probe is the culprit** (`interaction-probe.mjs`, engine's own `discoverInteractiveStates`): before probing — 51 URLs / 28 content / 68 imgs; after probing — **15 URLs / 0 content / 20 imgs, and `page.url()` had navigated to `https://dci-indonesia.com/get-in-touch`**. The 15 survivors are exactly the site-chrome set (logo/icons/backgrounds) present in every crawl manifest.
- **Root cause & confidence**: `discoverInteractiveStates` clicks every interactive element (modal/overlay discovery) and cannot restore the document afterwards — clicks include SPA navigation triggers (observed: the page navigated routes mid-probe). The engine then ran `enqueueLinks`, `discoverHashAnchors`, and `discoverImageAssets` on that click-mutated/navigated DOM, so asset discovery sampled the wrong document and silently lost every content image (and links/hash captures sampled the wrong page). Confidence: **high** (deterministic A/B with the engine's own functions; 51 → 15 URLs reproduced).
- **Failure category**: A (crawler evidence-pipeline ordering — "inconsistent viewport/browser-state handling" class).
- **Fix — exact source files changed** (`src/verifier/` untouched):
  - `src/crawler/engine.ts`: the route loop's read-only evidence passes (link discovery, hash-anchor sub-captures, asset discovery) now run on the pristine document **before** the interactive probe, and `discoverInteractiveStates` — the one DOM-mutating pass — runs last (its `modalCaptures` still attach to the route record before it is stored). The shared 30s SPA budget bounds both probes as before.
- **Why general-purpose**: every site with click-to-navigate controls (menus, tabs, carousels, CTAs) was at risk of losing content imagery and mis-sampling links; ordering evidence capture before state mutation is correct for any target. No site-specific value involved.
- **Regression tests added**: `tests/pristine-evidence.test.ts` — 2 source-invariant tests (all three read-only passes precede the mutating probe; the probe is the documented click-based mutator). Suite **254/254** green (`pnpm typecheck` 0, `pnpm build` 0, `git diff --check` clean, `src/verifier/` diff = 0 lines).
- **Expected impact & potential regressions**: content imagery (hero photos, partner logos, media-library images) now reaches the mirror and the synthesizer's asset map, so pages with photographic regions can reproduce them at build time. Risks checked: the interactive pass still runs per route and still attaches modal captures; its own screenshots may capture post-click states (pre-existing behavior, noted); hash screenshots now show pristine states (strictly more faithful).
- **Related observation (documented, not changed)**: the interactive probe may SPA-navigate mid-run, which degrades the *quality* of its own modal captures (a navigation is not a modal). Independent future work: confine clicks to elements whose activation opens overlays, or restore the document after probing. No fidelity evidence requires it this round.

## Attempt-3 pre-run state

- Validation re-run before Attempt 3: `pnpm typecheck` 0 · `pnpm test` **254/254** · `pnpm build` 0 · `git diff --check` clean · `src/verifier/` diff = 0 · no target-specific strings in the shared diff.

## Exp6 Attempt 3 (Run 3) — final full clone-and-verify — FAILED (target unmet; budget exhausted)

UTC window: `2026-10-19T11:49Z` → `2026-10-19T12:15:07Z` (3-tier report `2026-10-19T12:14:25.614Z`; live retry `12:15:07.327Z`). Run directory: `.apograph/runs/exp6-attempt-3/` (fully fresh). Source: `902b2a3` + remediations #14–#17 + round tests. Completed attempts: 3 / 3 — **budget exhausted**.

### Step 2 — Source validation

- `pnpm typecheck` 0 · `pnpm test` 254/254 · `pnpm build` 0 · `git diff --check` clean · `src/verifier/` diff = 0.

### Step 3 — Fresh clone

- Same effective command/config (methodology frozen) + remediated env; exit code 1 (visuals below threshold). Routes 3/3. **Remediation #17 confirmed live**: the manifest now carries **89 assets (was 18)** — 51 Cloudfront CDN images + 8 Next.js image-optimizer variants of the hero photo `forest-building.jpg` — all downloaded, 0 failed, 0 external. The emitted pages now reference the mirrored content imagery (`/assets/*.jpg|jpeg|png` in `src/pages/`).

### Step 4 — Verification results (machine-readable)

- 3-tier (`verification-report.json`, `2026-10-19T12:14:25.614Z`): build **PASS**, routes **PASS** (3/3, 0 console errors/exceptions). Visuals (final states after bounded repair):

| Route | Desktop mismatch | Mobile mismatch | vs 15% gate |
|---|---|---|---|
| `/` | **78.56%** | **81.60%** | **FAIL** |
| `/about-us` | **39.51%** | **27.51%** | **FAIL** |
| `/why-dci` | 11.61% | 9.23% | **PASS** |

- Repair records (machine-readable): `/` desktop 78.56→78.59 (reverted), `/` mobile 81.60→81.59 (reverted), `/about-us` desktop 39.51→24.39 (candidate reverted by the no-regression gate), `/about-us` mobile 27.51→53.72 (regression, reverted), `/why-dci` mobile **22.64→9.23 [FIXED]** (kept).
- Live (`clone-verify-report.json` retry 2, `2026-10-19T12:15:07.327Z`): `/` **21.44%**, `/about-us` **60.76%**, `/why-dci` **88.39%** — mean **56.86%**, 1/3 routes ≥ 85.
- Cross-attempt trajectory (live): `/` 10.8 → **21.4**; `/about-us` 53.7 → **60.8**; `/why-dci` 90.7 → 88.4 (both runs PASS-ish, 3-tier green). Remediation #17 moved the pipeline-critical needle (content imagery now mirrored and used) but the remaining gap on `/` is synthesis composition, not evidence.

### Step 5 — Decision

**FAILED.** The N_INPUT=3 budget is exhausted; the target is unmet on `/` (both viewports) and `/about-us` (both viewports). Per §8 the loop stops — no threshold lowered, no budget extended.

### Residual analysis (Attempt 3, machine-measured)

- **`/` failure is the hero composition**: live-pair band analysis (pixelmatch 0.1) — hero band y0–723 = **80.3%** mismatch while the remaining viewport (y723+) is only **5.4%**. The original hero is a full-bleed photographic `<img>` (Cloudfront `…2nsxdv.jpg`, `object-cover`) with headline overlay; the synthesized hero places different mirrored imagery with different geometry (the model chose among 51 candidate images and composed the section by eye). Mid/lower sections of `/` already reproduce well.
- `/about-us` residuals are moderate and its repair turn showed a large but regression-gated swing (desktop candidate 24.4% vs mobile 53.7%) — run-to-run synthesis variance remains a factor.
- `/why-dci` passes consistently (3-tier green two attempts running).

### Known remaining gaps (ranked, for future work)

1. **Hero/photographic-region composition** (Category B/C): the vision model selects and places large photographic assets by eye from a 51-image asset map. Candidate capabilities: (a) evidence-driven hero-region binding — record which asset occupies which measured region during capture (region → asset URL mapping from the DOM), so synthesis gets "this hero region IS this file" instead of choosing; (b) screenshot-region cropping fallback for hero surfaces (the `visual-extract` mechanism already does this for background-image surfaces — extend to large `<img>` surfaces lacking a usable src).
2. **Interactive probing quality** (Category A, documented in #17): clicks can SPA-navigate mid-probe, degrading the probe's own modal captures; confine clicks to overlay-opening triggers or restore the document afterwards.
3. **Category D verifier maintenance** (documented, untouched per Rule A): `cloneVerify.navigateBoth()` hard `networkidle` navigation; adopt `src/crawler/navigation.ts` semantics.
4. Animations absent in clone (marquee/scroll/pulse families) — outside static pixel scoring.

---

# Experiment 6 — Final Summary

## Attempt ledger

| Run | Outcome | Key scores |
|---|---|---|
| Exp6 Attempt 1 (Run 1) | FAILED — 1/3 routes; `networkidle` route drops; no content imagery | `/` 3-tier 84.6%/69.5%; live aborted |
| Exp6 Attempt 2 (Run 2) | FAILED — `/`, `/about-us` below target; `/why-dci` passes | live 10.8 / 53.7 / 90.7 (mean 51.7%) |
| Exp6 Attempt 3 (Run 3) | FAILED — target unmet; budget exhausted | live 21.4 / 60.8 / 88.4 (mean 56.9%); 3-tier `/why-dci` green |

## Final measured scores (Exp6 Attempt 3)

| Route | Live desktop+mobile (single-column live capture) | 3-tier desktop mismatch | 3-tier mobile mismatch |
|---|---|---|---|
| `/` | **21.44%** FAIL | 78.56% FAIL | 81.60% FAIL |
| `/about-us` | **60.76%** FAIL | 39.51% FAIL | 27.51% FAIL |
| `/why-dci` | **88.39%** PASS | 11.61% PASS | 9.23% PASS |
| Overall (live mean) | **56.86%** (1/3 routes) | | |

## Integrity attestation (Experiment 6)

- `src/verifier/` **not modified** (0 diff lines vs HEAD before and after all attempts). No thresholds, scoring, aggregation, fixtures, or assertions changed. All scores above come from the attempts' own machine-readable reports; no reference screenshots/expected scores/reports were generated, edited, or substituted; every attempt produced a fresh crawl/synthesis/capture in an isolated run directory; historical runs were diagnostic-only.
- No route or viewport comparison omitted; no failing route hidden. Rule C compliance enforced (no runtime layout forcing in emitted projects — `tests/emit-hygiene.test.ts` pins it; `dist` generator scan shows zero `MutationObserver`/`addEventListener`/timer emissions).
- Shared-source changes are target-agnostic (grep-verified over the full shared diff: zero occurrences of the target hostname/route names). Target similarity never lowered (85); budget never extended (N_INPUT=3, exactly 3 completed attempts).
- Baseline preserved: staged/user work untouched; all Experiment-6 changes are unstaged working-tree edits + untracked files listed below.

## Shared source modifications (Experiment 6, general-purpose)

- `src/synthesizer/modular.ts` — remediation #14: measured-geometry prompt contracts now mandate semantic flexbox/grid layout at build time (no fixed pixel widths / forced nowrap / coordinate nudging).
- `src/crawler/assets.ts` — remediation #15: cross-origin image mirroring through the validated download path (SSRF policy + MIME/size budgets unchanged; policy-valid cross-origin redirects allowed).
- `src/crawler/navigation.ts` (NEW) — remediation #16: `gotoWithReadiness`/`reloadWithReadiness` (networkidle preferred; committed-navigation timeout degrades to an explicit settled:false + settle delay; real failures still throw).
- `src/crawler/engine.ts` — remediation #16 (route nav + capture-state reloads use the helper) and #17 (read-only evidence passes — links, hash sub-captures, asset discovery — run on the pristine DOM before the mutating interactive probe, which now runs last).
- `src/plan/evidenceGate.ts` — remediation #16 (recrawl navigation via the helper).
- `package.json` — test suite list (+4 new test files).
- Tests: `tests/emit-hygiene.test.ts` (3), `tests/asset-mirror.test.ts` (4), `tests/navigation-readiness.test.ts` (5), `tests/pristine-evidence.test.ts` (2); `tests/capture-state.test.ts` updated to the equivalent reload mechanism. Suite **254/254**.

## Target-specific modifications

- None in shared source. Generated projects under `.apograph/runs/exp6-attempt-*/output/` are per-run artifacts.

## Regression coverage

- `pnpm typecheck` 0 · `pnpm test` 254/254 · `pnpm build` 0 · `git diff --check` clean. Cross-target validation: generic fixtures (`example.com`/`cdn.example.org`) plus this round's target itself (a materially different Next.js SSR site vs the prior Angular SPA).

## Evidence locations (Experiment 6)

- This log: `automate-testing-self-fixing.md` (prior rounds archived at `docs/experiments/exp-1-to-5-audit.md`)
- Attempts: `.apograph/runs/exp6-attempt-{1,2,3}/` (evidence bundles incl. manifests, generated outputs, `verification-report.json`, `clone-verify-report.json` + retry records, `clone-verify/` screenshots + diffs, `.apograph-verification/` 3-tier diffs, `clone.log` transcripts).
- Diagnosis tooling (experiment-only, untracked): `.apograph/runs/analysis/` — `asset-sequence-probe.mjs`, `crawl-order-probe.mjs`, `crawl-full-probe.mjs`, `storage-clear-probe.mjs`, `timing-probe.mjs`, `interaction-probe.mjs`, `palette-drift.mjs` (earlier rounds).

## Final status (Experiment 6)

| Criterion | Result |
|---|---|
| Overall similarity ≥ 85% | **FAIL** (live mean 56.86%; 1/3 routes ≥ 85) |
| All required routes ≥ 85 | **FAIL** (`/` 21.44%, `/about-us` 60.76%) |
| Typecheck / tests / build | **PASS** (0 / 254/254 / 0) |
| Generated app builds and serves | **PASS** (tsc ok, vite ok; 3/3 routes 200, 0 console errors) |
| No verifier modifications | **PASS** (0 diff lines) |
| No fabricated evidence / stale reuse | **PASS** (fresh isolated runs) |
| No target-specific shared-source hacks | **PASS** (grep-verified) |
| Rule C (no runtime layout forcing) | **PASS** (enforced by `tests/emit-hygiene.test.ts`) |
| **Overall acceptance** | **FAILED** (target unmet at N_INPUT=3; budget exhausted) |

## Evidence addendum — supplementary live mobile comparison (Attempt 3 output)

Collected post-attempt for dual-viewport completeness (standalone `clone-verify --viewport mobile` on the attempt-3 output; `clone-verify-mobile-report.json`, `2026-10-19T12:18:38.303Z`):

| Route | Live mobile similarity | vs 85 |
|---|---|---|
| `/` | **18.51%** | FAIL |
| `/about-us` | **72.59%** | FAIL |
| `/why-dci` | **90.77%** | PASS |

- Live mobile mean 60.62%, 1/3 routes. This confirms the FAILED verdict from the independent mobile methodology; the 3-tier dual-viewport comparisons above already provided per-viewport evidence.
