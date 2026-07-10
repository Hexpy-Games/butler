import { createHash } from "crypto";
import type { PromptUsageSectionAttribution } from "../../../../integrations/providers/provider.ts";
import {
  compileTurnContract,
  evidenceObligationSatisfied,
  TURN_CONTRACT_ACTIONS,
  TURN_CONTRACT_DECISION_SCHEMA,
  TURN_DELIVERABLES,
  TurnContractStore,
  type CompiledTurnContract,
  type EvidenceObligationSeed,
  type TurnContractCandidates,
  type TurnContractDecision,
  type TurnDeliverable,
} from "../../turn-contract.ts";
import type { WorkStreamResumeCandidate } from "../../workstream-checkpoint-resume-types.ts";
import { WorkStreamStore, type WorkStreamRecord } from "../../../work/work-stream.ts";

export const TURN_DECISION_REPAIR_LIMIT = 1;

export interface StructuredDecisionPrompt {
  prompt: string;
  promptSections: PromptUsageSectionAttribution[];
  responseFormat: {
    type: "json_schema";
    name: string;
    strict: true;
    schema: Record<string, unknown>;
  };
  decisionId: string;
}

export function stableTurnDecisionId(turnId: string): string {
  return `decision-${createHash("sha256").update(turnId).digest("hex").slice(0, 24)}`;
}

export function typedTurnDecisionInstructions(input: {
  decisionId: string;
  projectId?: string | null;
  candidateIds: readonly string[];
}): string {
  return [
    "## Typed Turn Decision",
    "Return one strict structured decision for the current user instruction.",
    `decision_id must be ${input.decisionId}.`,
    "This is the first productive pass, not a separate natural-language classifier.",
    "Use answer only when the response can be delivered now without tools or durable work; include the complete answer_text.",
    "Use inspect only for a status/report request that does not ask to change or continue work; include status_report only.",
    "Use start_work for new durable work. Use resume_work or modify_work only for a listed compatible WorkStream.",
    "Use cancel_work only for a listed WorkStream. Use supply_user_action only for its listed waiting-user blocker.",
    "For implementation or mutation include the actual durable deliverables, not status_report alone.",
    "For mixed status-and-work instructions include status_report plus the execution deliverables.",
    "public_summary explains why this action satisfies the request. immediate_next_step names only the next small step.",
    `Active project id: ${input.projectId?.trim() || "none"}.`,
    `Compatible WorkStream ids: ${input.candidateIds.length > 0 ? input.candidateIds.join(", ") : "none"}.`,
    "Do not infer from keyword dictionaries, regexes, or final-answer prose. Do not mention hidden control data.",
  ].join("\n");
}

export function turnDecisionResponseFormat(input: {
  decisionId: string;
  projectId?: string | null;
  candidateIds: readonly string[];
  waitingBlockerIds: readonly string[];
}): StructuredDecisionPrompt["responseFormat"] {
  return {
    type: "json_schema",
    name: "butler_turn_contract_decision",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "schema_version", "decision_id", "action", "target_workstream_id", "target_project_id",
        "blocker_id", "deliverables", "answer_text", "public_summary", "immediate_next_step",
      ],
      properties: {
        schema_version: { type: "string", const: TURN_CONTRACT_DECISION_SCHEMA },
        decision_id: { type: "string", const: input.decisionId },
        action: { type: "string", enum: [...TURN_CONTRACT_ACTIONS] },
        target_workstream_id: { enum: [null, ...input.candidateIds] },
        target_project_id: { enum: [null, ...(input.projectId?.trim() ? [input.projectId.trim()] : [])] },
        blocker_id: { enum: [null, ...input.waitingBlockerIds] },
        deliverables: {
          type: "array",
          items: { type: "string", enum: [...TURN_DELIVERABLES] },
        },
        answer_text: { type: ["string", "null"] },
        public_summary: { type: "string", minLength: 1, maxLength: 320 },
        immediate_next_step: { type: ["string", "null"], maxLength: 240 },
      },
    },
  };
}

export function parseStructuredTurnDecision(text: string, expectedDecisionId: string): TurnContractDecision {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("turn_contract_decision_invalid_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("turn_contract_decision_invalid_object");
  }
  const record = value as Record<string, unknown>;
  if (record.decision_id !== expectedDecisionId) throw new Error("turn_contract_decision_id_mismatch");
  return compactOptionalDecisionFields({
    schema_version: record.schema_version as TurnContractDecision["schema_version"],
    decision_id: String(record.decision_id ?? ""),
    action: record.action as TurnContractDecision["action"],
    target_workstream_id: nullableString(record.target_workstream_id),
    target_project_id: nullableString(record.target_project_id),
    blocker_id: nullableString(record.blocker_id),
    deliverables: Array.isArray(record.deliverables) ? record.deliverables as TurnDeliverable[] : [],
    answer_text: nullableString(record.answer_text),
    public_summary: String(record.public_summary ?? ""),
    immediate_next_step: nullableString(record.immediate_next_step),
  });
}

export function turnContractCandidates(input: {
  butlerData: string;
  candidates: readonly WorkStreamResumeCandidate[];
}): TurnContractCandidates {
  const streams = new WorkStreamStore(input.butlerData);
  const contracts = new TurnContractStore(input.butlerData);
  return {
    workstreams: input.candidates.flatMap((candidate) => {
      const record = streams.read(candidate.id);
      if (!record) return [];
      const activeContract = record.active_contract_id ? contracts.read(record.active_contract_id) : null;
      const unsatisfied = activeContract
        ? activeContract.required_evidence
          .filter((obligation) => !evidenceObligationSatisfied({
            contract: activeContract,
            obligation,
            receipts: contracts.evidenceFor(activeContract),
          }))
          .map(({ obligation_id: _id, ...seed }) => seed)
        : legacyObligations(record);
      return [{
        workstream_id: record.id,
        state: record.state,
        unsatisfied_obligations: unsatisfied,
        ...(record.active_blocker_id ? { waiting_user_blocker_id: record.active_blocker_id } : {}),
      }];
    }),
  };
}

export function compileStructuredTurnDecision(input: {
  decision: TurnContractDecision;
  candidates: TurnContractCandidates;
  workspaceId: string;
  projectId?: string | null;
  now?: Date;
}): CompiledTurnContract {
  if (
    input.decision.target_project_id && input.projectId &&
    input.decision.target_project_id !== input.projectId
  ) {
    throw new Error("turn_contract_project_target_mismatch");
  }
  return compileTurnContract({
    decision: input.decision,
    candidates: input.candidates,
    obligationRequirements: obligationRequirements(input),
    now: input.now,
  });
}

export function structuredDecisionRepairPrompt(input: {
  prompt: string;
  error: unknown;
}): string {
  const code = input.error instanceof Error ? input.error.message : "turn_contract_decision_invalid";
  return [
    input.prompt,
    "## Structured Decision Repair",
    `The prior structured value failed validation with code: ${code}.`,
    "Return one corrected value using the same JSON schema. Do not add prose and do not change the requested objective.",
  ].join("\n\n");
}

function obligationRequirements(input: {
  decision: TurnContractDecision;
  workspaceId: string;
  projectId?: string | null;
}): Partial<Record<TurnDeliverable, EvidenceObligationSeed>> {
  const projectId = input.decision.target_project_id ?? input.projectId ?? "active-project";
  const workstreamId = input.decision.target_workstream_id ?? input.workspaceId;
  const requirements: Partial<Record<TurnDeliverable, EvidenceObligationSeed>> = {};
  for (const deliverable of input.decision.deliverables) {
    const targetKind = deliverable === "status_report" || deliverable.startsWith("ledger_")
      ? "project"
      : deliverable === "final_report" ? "report" : "workspace";
    requirements[deliverable] = {
      deliverable,
      target_kind: targetKind,
      target_id: targetKind === "project" ? projectId : targetKind === "report" ? workstreamId : input.workspaceId,
      generation: 1,
      cardinality: 1,
      expected_item_ids: [],
    };
  }
  return requirements;
}

function legacyObligations(record: WorkStreamRecord): EvidenceObligationSeed[] {
  const generation = record.record_generation ?? 1;
  const workspace = record.project_id ?? record.id;
  if (record.state === "reporting") return [seed("final_report", "report", record.id, generation)];
  if (record.state === "reviewing" || record.state === "consolidating") {
    return [
      seed("review", "workspace", workspace, generation),
      seed("final_report", "report", record.id, generation),
    ];
  }
  return [
    seed("code_change", "workspace", workspace, generation),
    seed("validation", "workspace", workspace, generation),
    seed("final_report", "report", record.id, generation),
  ];
}

function seed(
  deliverable: TurnDeliverable,
  targetKind: EvidenceObligationSeed["target_kind"],
  targetId: string,
  generation: number,
): EvidenceObligationSeed {
  return { deliverable, target_kind: targetKind, target_id: targetId, generation };
}

function compactOptionalDecisionFields(decision: TurnContractDecision): TurnContractDecision {
  return Object.fromEntries(Object.entries(decision).filter(([, value]) => value !== undefined)) as unknown as TurnContractDecision;
}

function nullableString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
