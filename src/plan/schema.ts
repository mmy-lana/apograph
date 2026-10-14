/**
 * apograph — Authoritative plan schema (Phase 3: Plan).
 *
 * The single source of truth for the reverse-engineering plan that gates all
 * downstream synthesis. A plan is generated deterministically from the
 * evidence bundle, reviewed (and optionally hand-edited) by a human through
 * the interactive approval gate, and only then marked `approved: true`.
 */

import { z } from 'zod';

/** Interaction kinds inferred from a11y-tree roles. */
export const InferredInteractionSchema = z.enum([
  'mobile-menu',
  'accordion',
  'tabs',
  'form-submit',
  'none',
]);

export type InferredInteraction = z.infer<typeof InferredInteractionSchema>;

/** One route of the plan. */
export const PlanRouteSchema = z.object({
  /** URL path of the route (e.g. `/`, `/about`). */
  path: z.string(),
  /** Document title captured at crawl time. */
  title: z.string(),
  /** PascalCase React component name (e.g. `HomePage`, `AboutPage`). */
  componentName: z.string(),
  /** Whether this route is included in synthesis. */
  included: z.boolean(),
  /** Interactions inferred from the route's a11y tree. */
  inferredInteractions: z.array(InferredInteractionSchema),
});

export type PlanRoute = z.infer<typeof PlanRouteSchema>;

/** Aggregated design system extracted from the evidence bundle. */
export const DesignSystemSchema = z.object({
  colors: z.record(z.string()),
  fonts: z.array(z.string()),
  spacing: z.array(z.string()),
  radii: z.array(z.string()),
});

export type DesignSystem = z.infer<typeof DesignSystemSchema>;

/**
 * The authoritative plan. All fields are required unless explicitly optional;
 * `approved` starts `false` and is only flipped by the approval gate.
 */
export const ApographPlanSchema = z.object({
  targetUrl: z.string().url(),
  appName: z.string(),
  stack: z.literal('react-vite-tailwind'),
  version: z.number(),
  approved: z.boolean(),
  /** ISO-8601 timestamp set when the plan is approved. */
  approvedAt: z.string().optional(),
  routes: z.array(PlanRouteSchema),
  designSystem: DesignSystemSchema,
  /** Assumptions the generator made (candidates for human review). */
  assumptions: z.array(z.string()),
  /** Unknowns the generator could not resolve from evidence. */
  unknowns: z.array(z.string()),
});

export type ApographPlan = z.infer<typeof ApographPlanSchema>;
