/**
 * apograph — Interactive approval gate (Phase 3: Plan).
 *
 * The plan generated from evidence is never synthesized until a human (or an
 * explicit `--yes`) approves it. Interactive sessions use @clack/prompts:
 * a route checklist to toggle `included`, a design-token / interaction
 * summary, an optional external-file editing round-trip with schema
 * re-validation, and a final confirmation that persists `approved: true`.
 */

import * as p from '@clack/prompts';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ApographPlanSchema } from './schema.js';
import type { ApographPlan } from './schema.js';
import { writePlanFile } from './generator.js';

/** Options for {@link runApprovalGate}. */
export interface ApprovalGateOptions {
  /** Auto-approve without prompts (CLI `--yes`). */
  nonInteractive?: boolean;
}

/** Non-zero exit signal thrown when the user cancels the gate. */
export class ApprovalCancelledError extends Error {
  constructor() {
    super('Plan approval was cancelled.');
  }
}

// ---------------------------------------------------------------------------
// Interactive rendering helpers
// ---------------------------------------------------------------------------

/** Renders the plan summary (target, stack, tokens, interactions) as text. */
function renderPlanSummary(plan: ApographPlan): string {
  const interactions = plan.routes
    .map((route) => `  ${route.path} -> ${route.inferredInteractions.join(', ')}`)
    .join('\n');

  return [
    `Target:   ${plan.targetUrl}`,
    `App:      ${plan.appName}`,
    `Stack:    ${plan.stack} (v${plan.version})`,
    `Routes:   ${plan.routes.length} (${plan.routes.filter((r) => r.included).length} included)`,
    '',
    'Design tokens:',
    `  Colors:  ${Object.keys(plan.designSystem.colors).length}`,
    `  Fonts:   ${plan.designSystem.fonts.length}` +
      (plan.designSystem.fonts.length > 0 ? ` — ${plan.designSystem.fonts.slice(0, 5).join(', ')}` : ''),
    `  Spacing: ${plan.designSystem.spacing.length}`,
    `  Radii:   ${plan.designSystem.radii.length}`,
    '',
    'Detected interactions:',
    interactions.length > 0 ? interactions : '  (none)',
    '',
    ...(plan.assumptions.length > 0
      ? ['Assumptions:', ...plan.assumptions.map((a) => `  - ${a}`), '']
      : []),
    ...(plan.unknowns.length > 0
      ? ['Unknowns:', ...plan.unknowns.map((u) => `  - ${u}`), '']
      : []),
  ].join('\n');
}

/** Aborts with {@link ApprovalCancelledError} when a prompt was cancelled. */
function assertNotCancelled<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Plan approval cancelled.');
    throw new ApprovalCancelledError();
  }
  return value as T;
}

/** Re-reads the plan file and validates it against the authoritative schema. */
async function reloadPlan(planPath: string): Promise<ApographPlan> {
  const raw: unknown = JSON.parse(await readFile(planPath, 'utf8'));
  const parsed = ApographPlanSchema.safeParse(raw);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Plan file failed schema validation:\n${issues}`);
  }

  return parsed.data;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * Runs the approval gate for a plan file.
 *
 * - `nonInteractive` (or CLI `--yes`): auto-approves immediately.
 * - Interactive: shows the plan summary, a route-inclusion multiselect, an
 *   optional external-file editing round-trip (re-validated against
 *   `ApographPlanSchema`), and a final confirmation. On approval the plan is
 *   persisted with `approved: true` and `approvedAt` set.
 *
 * Returns the approved plan.
 */
export async function runApprovalGate(
  planPath: string,
  options: ApprovalGateOptions = {},
): Promise<ApographPlan> {
  const plan = await reloadPlan(planPath);

  if (options.nonInteractive) {
    const approved: ApographPlan = {
      ...plan,
      approved: true,
      approvedAt: new Date().toISOString(),
    };
    await writePlanFile(planPath, approved);
    return approved;
  }

  p.intro(`apograph plan approval — ${resolve(planPath)}`);

  let working: ApographPlan = plan;

  while (true) {
    p.note(renderPlanSummary(working), 'Plan summary');

    // --- Route checklist ---------------------------------------------------
    const selected = assertNotCancelled(
      await p.multiselect({
        message: 'Select routes to include in synthesis:',
        initialValues: working.routes.filter((r) => r.included).map((r) => r.path),
        required: false,
        options: working.routes.map((route) => ({
          value: route.path,
          label: `${route.componentName} (${route.path})`,
          hint:
            route.title.length > 0
              ? route.title.slice(0, 60)
              : route.inferredInteractions.join(', '),
        })),
      }),
    ) as string[];

    working = {
      ...working,
      routes: working.routes.map((route) => ({
        ...route,
        included: selected.includes(route.path),
      })),
    };
    await writePlanFile(planPath, working);

    // --- External file editing --------------------------------------------
    const wantsEdit = assertNotCancelled(
      await p.confirm({
        message: 'Edit the plan file manually before approving?',
        initialValue: false,
      }),
    );

    if (wantsEdit) {
      p.log.info(`Plan file: ${resolve(planPath)}`);
      assertNotCancelled(
        await p.confirm({
          message: 'Done editing? (the file will be re-read and validated)',
          initialValue: true,
        }),
      );

      try {
        working = await reloadPlan(planPath);
        p.log.success('Plan file re-validated against ApographPlanSchema.');
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        p.log.error(`Re-validation failed:\n${reason}`);
        const retry = assertNotCancelled(
          await p.confirm({
            message: 'Fix the file and try again?',
            initialValue: true,
          }),
        );
        if (retry) continue;
        p.cancel('Plan approval cancelled.');
        throw new ApprovalCancelledError();
      }
    }

    // --- Final confirmation -------------------------------------------------
    const approve = assertNotCancelled(
      await p.confirm({
        message: `Approve this plan and start synthesis (${working.routes.filter((r) => r.included).length} route(s) included)?`,
        initialValue: true,
      }),
    );

    if (approve) {
      const approved: ApographPlan = {
        ...working,
        approved: true,
        approvedAt: new Date().toISOString(),
      };
      await writePlanFile(planPath, approved);

      p.outro(`Plan approved and saved to ${resolve(planPath)}.`);
      return approved;
    }

    const keepEditing = assertNotCancelled(
      await p.confirm({
        message: 'Plan not approved. Return to the checklist?',
        initialValue: true,
      }),
    );

    if (!keepEditing) {
      p.cancel('Plan approval cancelled.');
      throw new ApprovalCancelledError();
    }
  }
}
