import { createHash } from "crypto";
import {
  TURN_CONTRACT_DECISION_SCHEMA,
  type TurnContractDecision,
} from "./turn-contract-types.ts";

export type TurnDecisionTransport =
  | { kind: "structured" }
  | { kind: "text_answer_wrapper" }
  | { kind: "provider_capability_missing"; code: "provider_capability_missing" };

export function selectTurnDecisionTransport(input: {
  supportsStructuredDecision: boolean;
  compatibleWorkstreamCount: number;
  runtimeRequiresTools: boolean;
}): TurnDecisionTransport {
  if (input.supportsStructuredDecision) return { kind: "structured" };
  if (input.compatibleWorkstreamCount === 0 && input.runtimeRequiresTools === false) {
    return { kind: "text_answer_wrapper" };
  }
  return { kind: "provider_capability_missing", code: "provider_capability_missing" };
}

export function wrapTextOnlyProviderAnswer(input: {
  text: string;
  logicalTurnId: string;
}): TurnContractDecision {
  if (!input.text.trim()) throw new Error("turn_contract_text_answer_empty");
  const decisionId = createHash("sha256")
    .update(`${input.logicalTurnId}\ntext-answer`)
    .digest("hex")
    .slice(0, 24);
  return {
    schema_version: TURN_CONTRACT_DECISION_SCHEMA,
    decision_id: `decision-${decisionId}`,
    action: "answer",
    deliverables: [],
    answer_text: input.text,
    public_summary: "Direct answer",
  };
}
