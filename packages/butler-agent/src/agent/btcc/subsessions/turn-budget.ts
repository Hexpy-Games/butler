import { ActionableRejectionError } from "../agent-loop/actionable-rejection.ts";
import { subsessionResultId } from "./identities.ts";
import type { TurnRecord } from "../turn/index.ts";
import type {
  CompleteStewardResultInput, SessionRelation, SubsessionDelegationDependencies,
} from "./contracts.ts";

const MAX_REPORT_EVIDENCE_CHARS = 2_000;

/**
 * max_turns bounds how many child Turns a relation may start: the initial
 * assignment plus each parent direction. Worker-result deliveries to a
 * Steward are not directions and never count. At the limit no new Turn
 * starts; the parent receives an incomplete result and an explanation.
 */
export async function enforceRelationTurnBudget(input: {
  store: Pick<SubsessionDelegationDependencies["store"], "latestDirection" | "packetByRelationId" | "resultByRelationId">;
  relation: SessionRelation;
  role: "steward" | "worker";
  childTurn: TurnRecord | null;
  commitIncomplete(result: CompleteStewardResultInput): Promise<unknown>;
}): Promise<void> {
  const max = input.store.packetByRelationId(input.relation.relation_id)?.access_and_budget_policy.max_turns;
  const used = 1 + (input.store.latestDirection(input.relation.relation_id)?.revision ?? 0);
  if (!max || used < max) return;
  let result = input.store.resultByRelationId(input.relation.relation_id)?.status ?? null;
  if (!result && input.childTurn?.semanticState === "delivered") {
    const report = input.childTurn.finalPayload?.content.trim();
    await input.commitIncomplete({
      childSessionId: input.relation.child_session_id,
      childTurnId: input.childTurn.turnId,
      resultId: subsessionResultId(input.relation.child_session_id, input.childTurn.turnId),
      status: "incomplete",
      code: "turn_budget_exhausted",
      summary: [
        `The ${input.role} used its turn budget (${used} of ${max} Turns) before finishing.`,
        ...(report ? [`Latest report: ${report.slice(0, MAX_REPORT_EVIDENCE_CHARS)}`] : []),
      ].join("\n"),
      acceptanceEvidence: [`Turns used: ${used} of ${max}`],
    });
    result = "incomplete";
  }
  throw new ActionableRejectionError({
    code: "turn_budget_exhausted",
    reason: `This ${input.role} relation has used its turn budget (${used} of ${max} Turns: the initial assignment and ${used - 1} direction(s)). No new Turn was started and the direction was not recorded.`,
    alternatives: [
      result ? `integrate the delivered ${result} result` : "wait for the child's result",
      "delegate a new assignment for the remaining work; it carries the prior attempts",
    ],
    state: { relation_id: input.relation.relation_id, turns_used: used, max_turns: max, result_status: result },
  });
}
