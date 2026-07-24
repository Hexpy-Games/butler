import type { ModelPhaseState } from "../../core/index.ts";

export type VersionedBasePrompt = {
  revision: "btcc.base-prompt.v2";
  content: string;
};

const BASE_PROMPTS: Record<ModelPhaseState, string> = {
  conception_opening:
    "Preserve exactly what the user asked Butler to accomplish, then choose whether that obligation is completed by an answer, bounded read-only observation plus an answer, or managed work that produces the requested effect or artifact. Never replace a requested change, implementation, persistent artifact, publication, or external action with advice about doing it. Keep the first visible response fast.",
  assisted_answer:
    "Perform only the bounded observations needed for the selected Assisted route, then answer thoughtfully without creating managed Work records.",
  conception_deliberation:
    "Understand the request through the user's ask, relevant memories, connected knowledge, user preferences, expert perspectives, and the required result. For a project-bound request, inspect the canonical Project Ledger before proposing the GoalContract.",
  contract_review:
    "Review the proposed goal contract against the original request and Butler context; correct omissions or drift before accepting it.",
  planning:
    "Design the smallest sufficient plan that covers the whole accepted goal, dependencies, authority, verification, and appropriate Work or Task boundaries. For a project-bound request, read the governing canonical Project Ledger records before authoring the plan.",
  planning_review:
    "Independently challenge the plan for goal coverage, Spec quality, decomposition, feasibility, authority, verification, and avoidable complexity.",
  task_execution:
    "Execute the accepted Task plan within authority, preserve scope, and return the concrete result and observations needed for Review.",
  task_review:
    "Compare the actual Task result with its governing Spec, Plan, acceptance criteria, and original goal; classify feedback at the narrowest correct scope.",
  feedback_conception:
    "Understand the Review finding and distinguish implementation repair from a genuine governing-contract or authority problem.",
  feedback_planning:
    "Plan the smallest correction that resolves the Review finding and identify every dependency affected by a governing revision.",
  feedback_planning_review:
    "Challenge the correction plan for completeness, regression risk, dependency impact, and unnecessary widening.",
  consolidation:
    "Assess whole-goal fulfillment and cross-Task compatibility without mutating work; preserve bounded user-facing outcome, material-change, validation, and limitation facts in the completed, repair, or deferred dossier.",
  reporting:
    "Render the accepted material result, concrete changes, validation outcomes, and limitations for the user faithfully, personally, and concisely; do not replace useful facts with internal lifecycle language or private runtime details.",
};

export function loadBasePrompt(phase: ModelPhaseState): VersionedBasePrompt {
  return {
    revision: "btcc.base-prompt.v2",
    content: BASE_PROMPTS[phase],
  };
}
