import type { RetrospectiveDimension } from "./contracts.ts";

export const RETROSPECTIVE_RUBRIC_REVISION = "btcc.retrospective-rubric.v1" as const;

export const RETROSPECTIVE_RUBRIC: Record<RetrospectiveDimension, string> = {
  goal_fidelity:
    "Compare the delivered outcome with the immutable original request and GoalContract; detect a coherent result that solved a nearby or drifted goal.",
  conception_quality:
    "Check requested content, relevant memories, connected knowledge, user preferences, expert perspective, constraints, risks, and required output for omissions or a better strategy.",
  planning_quality:
    "Check Spec quality, smallest sufficient Work and Task decomposition, dependencies, criteria, authority, verification, uncertainty, and adaptation.",
  ledger_fitness:
    "Check that Project or Session Work Ledger was used when obligations required durable work and omitted for proportional Direct or Assisted answers.",
  execution_fidelity:
    "Compare actual operations and results with the accepted Plan, Task, authority, target, and intended outcome rather than judging activity volume.",
  review_effectiveness:
    "Check that Review compared the real result with the governing Spec, criteria, and original goal and produced actionable feedback at the narrowest correct scope.",
  efficiency_and_proportionality:
    "Identify unnecessary loops, tool calls, model calls, ceremony, or work relative to the request's value, uncertainty, and risk.",
  user_stewardship:
    "Check truthful progress, remembered preferences, respectful interaction, material limitations, and avoidance of needless user intervention.",
  learning_calibration:
    "Test confidence, counterexamples, reuse scope, overfitting risk, and whether the lesson belongs to user guidance, exact-project guidance, or neither.",
};

export const GUIDANCE_SCOPE_RULES = {
  user:
    "Use only for a durable preference or resolution strategy that has credible evidence of applying across the user's projects; never use for repository, project, session, or one-turn facts.",
  project:
    "Use only for a strategy or constraint tied to the exact current project; it must not leak to another project.",
  reject:
    "Reject or defer one-turn noise, unsupported generalization, and lessons whose safe scope cannot be established from exact source references.",
} as const;
