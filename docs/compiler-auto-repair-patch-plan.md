# Patch Plan — Compiler Resilience & Closed-Loop Code Repair

Goal: minor LLM type quirks (e.g. TS2322 Lucide icon vs `ReactNode`) must never
abort `vite build`, so `dist/index.html` always exists and Tiers 2/3 execute.
`repairCodeFile` gets its first real caller: a bounded, single-turn auto-repair
inside `verifyBuild`.

---

## 1. `src/emitter/scaffold.ts` — `generateFrontendScaffold`

Signature unchanged: `generateFrontendScaffold(appName: string, metadata?: RouteMetadata): ProjectFile[]`

| Emitted file      | Edit |
|-------------------|------|
| `tsconfig.json`   | `compilerOptions.strict: false`; add `compilerOptions.noImplicitAny: false` (keep `noUnusedLocals/Parameters: false`, `verbatimModuleSyntax: false` as-is) |
| `package.json`    | `scripts.dev: 'vite --host 0.0.0.0'` (was `'vite'`) |
| `vite.config.ts`  | `server: { port: 5173, strictPort: false, host: true }` (was `server: { port: 5173 }`) |

Rationale: with `strict: false` + `noImplicitAny: false`, TS2322/TS7006-class
quirks stop surfacing at all; `--host`/`host: true`/`strictPort: false` make the
dev server reachable from containers/CI and resilient to port collisions.

## 2. `src/synthesizer/modular.ts` — `SYSTEM_GUIDELINES`

Append one bullet to the array (after rule 3 / near the type-only-import bullet):

```
'- When rendering icons from lucide-react in maps, lists, or components, store the component reference and render as `<item.icon className="..." />`, or store JSX elements directly `icon: <Shield className="..." />`. Never assign string names and component references to the same property.'
```

Follow-up (out of scope, flagged): `src/synthesizer/frontend.ts:179` carries a
duplicate `SYSTEM_GUIDELINES`; give it the same bullet for parity.

## 3. `src/verifier/report.ts` — extend `BuildCheck`

```ts
/** One compiler auto-repair turn (Tier 1 resilience). */
export interface CompilerRepairRecord {
  /** Source files (relative to outputDir) sent through repairCodeFile. */
  repairedFiles: string[];
  /** True when the post-repair `tsc --noEmit` re-run passed. */
  fixed: boolean;
  /** Parsed diagnostic lines that drove the repair. */
  errorsBefore: string[];
}

export interface BuildCheck {
  success: boolean;          // NEW semantics: dist/ artifacts were produced (vitePassed)
  tscPassed: boolean;        // final tsc status after the repair turn
  vitePassed: boolean;
  errors: string[];
  repair?: CompilerRepairRecord;   // present iff a repair turn ran
  typecheckBypassed?: boolean;     // tsc still failing, vite build forced through
}
```

`printVerificationSummary` (line ~135): `tsc ok` | `tsc FAILED` →
`tsc ok (repaired)` | `tsc FAILED (residual — build bypassed)`.

`success` semantics change from `tsc && vite` to `vitePassed`: this also unblocks
`defaultRebuild` in the visual-repair loop, which currently dies on residual type
errors. Report truth stays in `tscPassed`/`typecheckBypassed`.

## 4. `src/verifier/engine.ts` — compiler auto-repair loop

New imports: `repairCodeFile` from `../synthesizer/llm.js` (same direction as the
existing `../synthesizer/vision.js` import), `writeFile` already present.

### New exported helpers (unit-testable, no tsc/LLM needed)

```ts
export interface CompilerDiagnostic {
  file: string;       // as printed by tsc, e.g. 'src/components/Hero.tsx'
  line: number;
  column: number;
  code: string;       // 'TS2322'
  message: string;    // full diagnostic block incl. continuation lines
}

/** Parses `tsc --noEmit` output into diagnostics (classic + pretty formats). */
export function parseTscDiagnostics(output: string): CompilerDiagnostic[];
```

- Classic regex: `/^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/`
- Pretty regex:  `/^(.+?):(\d+):(\d+)\s+-\s+error\s+(TS\d+):\s+(.*)$/`
- Continuation lines (indented message detail / code frames) fold into the
  current diagnostic until the next match.
- Repair targets filtered: `file.startsWith('src/')`, non-`node_modules`, and
  parseable file-bearing diagnostics only (config-level TS5xxx/TS6053 skipped).

### Injectable runtime deps + the loop

```ts
export interface CommandResult { ok: boolean; output: string; }   // make exportable

export interface Tier1Deps {
  run(command: string, args: string[], cwd: string): Promise<CommandResult>;
  repairFile(filePath: string, currentContent: string, errors: string[]): Promise<string>;
}

/** Max files sent through one repair turn (token bound). */
const MAX_REPAIR_FILES = 3;
/** Max diagnostic lines forwarded per file. */
const MAX_REPAIR_ERRORS = 20;

/** Tier 1 core: install, tsc (+1 repair turn), vite build. */
export async function runTier1Build(cwd: string, deps: Tier1Deps): Promise<BuildCheck>;

export interface BuildRepairOptions {
  maxRepairTurns?: number;                 // default 1; 0 disables the loop
  repairFile?: Tier1Deps['repairFile'];    // test seam; default repairCodeFile
}

export async function verifyBuild(
  outputDir: string,
  options: BuildRepairOptions = {},
): Promise<BuildCheck>;
```

`verifyBuild` keeps its install logic, then delegates to `runTier1Build` with
`{ run: runCommand, repairFile: options.repairFile ?? repairCodeFile }`. Existing
callers (`runVerification`, `defaultRebuild`) need no changes.

### Loop flow inside `runTier1Build`

1. `tsc --noEmit` (via `deps.run('npx', ['--no-install','tsc','--noEmit'], cwd)`).
2. On failure and `maxRepairTurns > 0`: `parseTscDiagnostics(tsc.output)` →
   group by `file`, take up to `MAX_REPAIR_FILES` `src/` files. For each:
   `readFile(join(cwd, file))` → `deps.repairFile(file, content, errors.slice(0, MAX_REPAIR_ERRORS))`
   → `writeFile` back. Record `CompilerRepairRecord`.
3. Re-run `tsc --noEmit` once. `repair.fixed = tsc2.ok`.
4. **Always** run `vite build` (both when the repair fixed tsc and when residual
   errors remain) so `dist/index.html` materializes; set
   `typecheckBypassed = !tscFinal.ok` when vite succeeded anyway.
5. Return `BuildCheck`. Legacy early return on install failure is unchanged
   (`success:false, tscPassed:false, vitePassed:false`, no repair).

Path guard: skip any diagnostic `file` that fails `resolve(cwd, file).startsWith(resolve(cwd))`.

`runVerification` diagnostics (line ~815): when `build.typecheckBypassed`, push
`'Residual type errors tolerated (N file(s) auto-repaired); dist/ built for visual tiers.'`

---

## 5. Tests

Conventions: `node:test` + `node:assert/strict`, import from `../dist/...`
(`pnpm test` runs `tsc` first). **`package.json` `test` script lists test files
explicitly — append `tests/compiler-repair.test.ts`.**

### `tests/ui.test.ts` (extend, alongside existing scaffold tests)

1. `scaffold > emitted tsconfig disables strict and noImplicitAny` —
   parse emitted `tsconfig.json`; `strict === false`, `noImplicitAny === false`.
2. `scaffold > dev script binds vite to 0.0.0.0` —
   emitted `package.json` `scripts.dev === 'vite --host 0.0.0.0'`.
3. `scaffold > vite config relaxes the port and binds all interfaces` —
   emitted `vite.config.ts` contains `port: 5173`, `strictPort: false`, `host: true`.
4. `source > system guidelines forbid mixed icon name/component properties` —
   source-level assert on `src/synthesizer/modular.ts`:
   includes `Never assign string names and component references to the same property`.

### `tests/compiler-repair.test.ts` (new)

5. `tsc parse > extracts file, position, and code from classic diagnostics` —
   fixture `src/components/Hero.tsx(12,18): error TS2322: Type '...' is not assignable to type 'ReactNode'.`
   (+ continuation line) → one diagnostic with `file`, `line:12`, `column:18`,
   `code:'TS2322'`, `message` containing the continuation text.
6. `tsc parse > extracts pretty-format diagnostics` —
   `src/App.tsx:4:9 - error TS2304: Cannot find name 'x'.` → same shape.
7. `tsc parse > non-file and out-of-src diagnostics are not repair targets` —
   TS6053/TS5xxx config errors and `node_modules/...` paths filtered out.
8. `build repair > one repair turn fixes tsc and vite build proceeds` —
   fake `run`: 1st tsc fail (fixture), 2nd tsc ok, vite ok (writes
   `dist/index.html`). Assert `repairFile` called exactly once with
   `'src/components/Hero.tsx'` and errors containing `TS2322`; file on disk equals
   repaired content; `tscPassed/vitePassed/success === true`, `repair.fixed === true`.
9. `build repair > residual tsc errors still force vite build` —
   tsc fails both runs, vite ok. Assert vite command executed,
   `typecheckBypassed === true`, `tscPassed === false`, `success === true`,
   `errors` retains the residual diagnostics.
10. `build repair > repair turn is bounded` —
    tsc always fails → `repairFile` called ≤ `MAX_REPAIR_FILES` times and never
    more than once per file; second tsc run happens exactly once.
11. `build repair > unparseable tsc output skips repair but still builds` —
    crash-only output → `repairFile` never called; vite build still attempted.
12. `build repair > install failure keeps the legacy early return` —
    temp cwd without `node_modules`; fake `run` reports install failure and
    creates nothing → `{success:false, tscPassed:false, vitePassed:false}`,
    no repair, no tsc/vite invocation.
13. `build repair > path traversal diagnostics are ignored` —
    diagnostic `file: '../outside.ts'` → `repairFile` never called for it.

All loop tests use the `runTier1Build`/`verifyBuild` `run` + `repairFile` seams —
no real `tsc`, `vite`, pnpm, or LLM in tests.

## Order of work

1. `scaffold.ts` + tests 1–3 (independent, safe).
2. `modular.ts` guideline + test 4.
3. `report.ts` type extensions + summary tweak.
4. `engine.ts` parser → `runTier1Build` → `verifyBuild` wiring + tests 5–13.
5. `pnpm typecheck && pnpm test`.
