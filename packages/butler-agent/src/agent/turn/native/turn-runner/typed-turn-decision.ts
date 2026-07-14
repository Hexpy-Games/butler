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
import {
  validateContinuityUpdates,
  type ContinuityCandidate,
} from "../../../cognition/continuity/continuity-store.ts";
import {
  CONTINUITY_KINDS,
  CONTINUITY_OPERATIONS,
  CONTINUITY_SCOPES,
  type ContinuityUpdate,
} from "../../turn-contract-types.ts";

export const TURN_DECISION_REPAIR_LIMIT = 1;

const DELIVERABLE_DECISION_GUIDANCE = [
  "Select only concrete output obligations required by the user's semantic objective.",
  "ledger_spec, ledger_work, and ledger_tasks mean canonical Project Ledger records only.",
  "ledger_tasks never means the bound runtime todo plan created with update_todo_list.",
  "A request for a task list, todo list, work list, checklist, or explicit plan before execution does not by itself request ledger_tasks.",
  "Every work action receives its bound runtime todo plan independently of deliverables and tracking mode.",
  "The active project id alone does not imply Ledger tracking.",
  "For local command, file, test, or operational verification with no intended durable diff, use validation; use code_change for an intended durable workspace mutation.",
  "resume_work may declare only execution deliverables already listed as unsatisfied for the selected WorkStream; use modify_work when the current request adds execution scope.",
].join(" ");

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
  continuityCandidates?: readonly ContinuityCandidate[];
}): string {
  return [
    "## Typed Turn Decision",
    "Return one strict structured decision for the current user instruction.",
    `decision_id must be ${input.decisionId}.`,
    "This is the first productive pass, not a separate natural-language classifier.",
    "Use answer only when the response can be delivered now without tools or durable work; include the complete answer_text.",
    "Use tool_answer for a general answer that requires public web evidence; include grounded_answer, set evidence_domain to public_web, and do not select project or WorkStream targets.",
    "Search and page-read outputs are evidence material. Do not force a search-then-read sequence: search material may support a claim, and a successful page read may still be insufficient.",
    "Set answer_text to null for every action except answer. For answer, set it to the complete response.",
    "Use inspect only for a project or workspace status/report request that does not ask to change or continue work; include status_report and select the exact inspection_scope.",
    "Reading, searching, or reviewing existing files without changing durable state is inspect with status_report, even when tools are required.",
    "The review deliverable is only for structured review evidence of changed, planned, or inherited work; it is not ordinary source inspection.",
    "Use start_work for new durable work. Use resume_work or modify_work only for a listed compatible WorkStream.",
    "For resume_work, keep execution deliverables within the selected WorkStream's inherited unsatisfied frontier. Use modify_work when the request adds a new execution deliverable.",
    "Every start_work, resume_work, or modify_work decision first creates or restores an explicit bound todo plan before ordinary tools run; the runtime opening placeholder is not that plan.",
    "The bound runtime todo plan is not a ledger_tasks deliverable. Never add ledger_tasks merely because the user asks for a task list, todo list, work list, checklist, or explicit plan before execution.",
    "Use ledger_spec, ledger_work, or ledger_tasks only when the semantic objective requires canonical Project Ledger records or the selected compatible WorkStream already has unsatisfied Ledger obligations.",
    "An active project id alone does not imply Ledger tracking. Ordinary local commands, files, tests, and operational checks remain local workspace work.",
    "For local command, file, test, or operational verification with no intended durable diff, select validation; select code_change for an intended durable workspace mutation.",
    "Use cancel_work only for a listed WorkStream. Use supply_user_action only for its listed waiting-user blocker.",
    "For implementation or mutation include the actual durable deliverables, not status_report alone.",
    "status_report means an explicitly requested read-only status snapshot; do not add it merely because the turn will end with a report.",
    "continuity_updates is the model-owned semantic continuity decision for this turn. Use an empty array for ordinary messages that create no useful future state.",
    "Add a bounded update only when a compact instruction, decision, constraint, working state, preference, or correction should affect a later relevant turn. Never copy the raw user message.",
    "Choose project scope for project-specific state, session scope for state useful only in this conversation, and global scope only for a durable cross-project rule or correction.",
    "Use upsert for new state. Use supersede or forget only with an exact target_ref from Active continuity candidates; absence never implies deletion.",
    "Do not put secrets, credentials, project ids, workspace paths, conversation ids, message ids, or filesystem destinations in a continuity update. Runtime binds provenance and storage scope.",
    "Post-change verification belongs to validation. The ordinary user-facing completion answer is the final candidate, not status_report.",
    "For a genuine mixed status-and-work instruction, include status_report only when the user separately requested the current status snapshot.",
    "public_title is one concise line naming the immediate work block. It must not repeat public_summary or immediate_next_step.",
    "public_summary states what this decision will do. public_rationale explains why this step is useful now. immediate_next_step explains how the result determines the following step.",
    `Active project id: ${input.projectId?.trim() || "none"}.`,
    `Compatible WorkStream ids: ${input.candidateIds.length > 0 ? input.candidateIds.join(", ") : "none"}.`,
    `Active continuity candidates: ${renderContinuityCandidates(input.continuityCandidates ?? [])}.`,
    "Do not infer from keyword dictionaries, regexes, or final-answer prose. Do not mention hidden control data.",
  ].join("\n");
}

export function turnDecisionResponseFormat(input: {
  decisionId: string;
  projectId?: string | null;
  candidateIds: readonly string[];
  waitingBlockerIds: readonly string[];
  continuityCandidates?: readonly ContinuityCandidate[];
}): StructuredDecisionPrompt["responseFormat"] {
  const continuityCandidateIds = input.continuityCandidates?.map((candidate) => candidate.continuity_id) ?? [];
  return {
    type: "json_schema",
    name: "butler_turn_contract_decision",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "schema_version", "decision_id", "action", "target_workstream_id", "target_project_id",
        "blocker_id", "evidence_domain", "inspection_scope", "deliverables", "continuity_updates", "answer_text", "public_title", "public_summary", "public_rationale", "immediate_next_step",
      ],
      properties: {
        schema_version: { type: "string", const: TURN_CONTRACT_DECISION_SCHEMA },
        decision_id: { type: "string", const: input.decisionId },
        action: { type: "string", enum: [...TURN_CONTRACT_ACTIONS] },
        target_workstream_id: { enum: [null, ...input.candidateIds] },
        target_project_id: {
          description: "The active project target. Selecting it does not imply canonical Project Ledger tracking.",
          enum: [null, ...(input.projectId?.trim() ? [input.projectId.trim()] : [])],
        },
        blocker_id: { enum: [null, ...input.waitingBlockerIds] },
        evidence_domain: { enum: [null, "public_web"] },
        inspection_scope: { enum: [null, "project", "workspace"] },
        deliverables: {
          type: "array",
          description: DELIVERABLE_DECISION_GUIDANCE,
          items: {
            type: "string",
            enum: [...TURN_DELIVERABLES],
            description: DELIVERABLE_DECISION_GUIDANCE,
          },
        },
        continuity_updates: {
          type: "array",
          maxItems: 4,
          description: "Compact model-selected state that should affect a later relevant turn. Empty is the normal result.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["scope", "kind", "operation", "summary", "target_ref"],
            properties: {
              scope: { type: "string", enum: [...CONTINUITY_SCOPES] },
              kind: { type: "string", enum: [...CONTINUITY_KINDS] },
              operation: { type: "string", enum: [...CONTINUITY_OPERATIONS] },
              summary: { type: "string", minLength: 1, maxLength: 500 },
              target_ref: { enum: [null, ...continuityCandidateIds] },
            },
          },
        },
        answer_text: { type: ["string", "null"] },
        public_title: { type: "string", minLength: 2, maxLength: 80 },
        public_summary: { type: "string", minLength: 1, maxLength: 320 },
        public_rationale: { type: "string", minLength: 1, maxLength: 320 },
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
    evidence_domain: nullableString(record.evidence_domain) as TurnContractDecision["evidence_domain"],
    inspection_scope: nullableString(record.inspection_scope) as TurnContractDecision["inspection_scope"],
    deliverables: Array.isArray(record.deliverables) ? record.deliverables as TurnDeliverable[] : [],
    continuity_updates: parseContinuityUpdates(record.continuity_updates),
    answer_text: nullableString(record.answer_text),
    public_title: nullableString(record.public_title) ?? legacyDecisionTitle(record),
    public_summary: String(record.public_summary ?? ""),
    public_rationale: nullableString(record.public_rationale) ?? String(record.public_summary ?? ""),
    immediate_next_step: nullableString(record.immediate_next_step),
  });
}

export function canonicalFunctionDecisionArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const action = typeof args.action === "string" ? args.action : "";
  return {
    ...args,
    continuity_updates: Array.isArray(args.continuity_updates) ? args.continuity_updates : [],
    ...(action && action !== "answer" ? { answer_text: null } : {}),
    ...(action && action !== "supply_user_action" ? { blocker_id: null } : {}),
    ...(action && action !== "tool_answer" ? { evidence_domain: null } : {}),
    ...(action && action !== "inspect" ? { inspection_scope: null } : {}),
  };
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
        tracking_mode: candidate.checkpoint.trackingMode,
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
  continuityCandidates?: readonly ContinuityCandidate[];
  now?: Date;
}): CompiledTurnContract {
  validateContinuityUpdates({
    updates: input.decision.continuity_updates ?? [],
    candidates: input.continuityCandidates ?? [],
    projectId: input.projectId,
  });
  if (
    input.decision.target_project_id && input.projectId &&
    input.decision.target_project_id !== input.projectId
  ) {
    throw new Error("turn_contract_project_target_mismatch");
  }
  const attachesProjectTarget = !["answer", "tool_answer", "inspect"].includes(input.decision.action);
  const decision = input.projectId?.trim() && !input.decision.target_project_id && attachesProjectTarget
    ? { ...input.decision, target_project_id: input.projectId.trim() }
    : input.decision;
  return compileTurnContract({
    decision,
    candidates: input.candidates,
    obligationRequirements: obligationRequirements(input),
    now: input.now,
  });
}

export function structuredDecisionRepairPrompt(input: {
  prompt: string;
  error: unknown;
  transport?: "json_schema" | "function_tool";
}): string {
  const code = input.error instanceof Error ? input.error.message : "turn_contract_decision_invalid";
  return [
    input.prompt,
    "## Structured Decision Repair",
    `The prior structured value failed validation with code: ${code}.`,
    `Required correction: ${structuredDecisionRepairGuidance(code)}`,
    input.transport === "function_tool"
      ? "Submit one corrected value through submit_turn_decision using the same schema and requested objective."
      : "Return one corrected value using the same JSON schema. Do not add prose and do not change the requested objective.",
  ].join("\n\n");
}

export function structuredDecisionRepairGuidance(code: string): string {
  switch (code) {
    case "turn_contract_non_answer_has_answer_text":
      return "Keep the selected non-answer action and set answer_text to null.";
    case "turn_contract_invalid_answer":
      return "For action answer, provide a complete non-empty answer_text and no deliverables.";
    case "turn_contract_required_deliverable_missing":
      return "Include every deliverable required by the selected action; inspect requires status_report.";
    case "turn_contract_duplicate_deliverables":
      return "Return each deliverable at most once.";
    case "turn_contract_deliverable_not_allowed":
      return "Remove deliverables that are not allowed for the selected action.";
    case "turn_contract_execution_requires_durable_deliverable":
    case "turn_contract_final_report_requires_durable_deliverable":
      return "Use inspect with status_report for read-only source inspection; otherwise keep the work action and include a concrete durable execution deliverable other than review.";
    case "turn_contract_missing_workstream_target":
    case "turn_contract_incompatible_workstream_target":
      return "Select one target_workstream_id from the supplied compatible candidates.";
    case "turn_contract_resume_deliverable_not_inherited":
      return "Keep resume_work and remove newly added execution deliverables, or use modify_work only when the current user request truly adds execution scope.";
    case "turn_contract_unexpected_blocker_id":
      return "Set blocker_id to null unless the action is supply_user_action.";
    case "turn_contract_supply_blocker_mismatch":
    case "turn_contract_supply_target_not_waiting":
      return "Use only the listed waiting-user WorkStream and its exact blocker id.";
    default:
      return "Preserve the requested objective and correct the value to satisfy the exact decision schema and action rules.";
  }
}

function obligationRequirements(input: {
  decision: TurnContractDecision;
  workspaceId: string;
  projectId?: string | null;
}): Partial<Record<TurnDeliverable, EvidenceObligationSeed>> {
  const projectId = input.decision.target_project_id ?? input.projectId;
  const workstreamId = input.decision.target_workstream_id ?? input.workspaceId;
  const requirements: Partial<Record<TurnDeliverable, EvidenceObligationSeed>> = {};
  for (const deliverable of input.decision.deliverables) {
    const targetKind = deliverable === "grounded_answer"
      ? "public"
      : deliverable === "status_report" && input.decision.inspection_scope === "workspace"
        ? "workspace"
        : deliverable === "status_report" || deliverable.startsWith("ledger_")
          ? "project"
      : deliverable === "final_report" ? "report" : "workspace";
    const targetId = targetKind === "public"
      ? "public-web"
      : targetKind === "project"
        ? requiredProjectTarget(projectId)
        : targetKind === "report" ? workstreamId : input.workspaceId;
    requirements[deliverable] = {
      deliverable,
      target_kind: targetKind,
      target_id: targetId,
      generation: 1,
      cardinality: 1,
      expected_item_ids: [],
    };
  }
  return requirements;
}

function requiredProjectTarget(value: string | null | undefined): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("turn_contract_project_evidence_target_missing");
  return value.trim();
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

function legacyDecisionTitle(record: Record<string, unknown>): string | undefined {
  const source = nullableString(record.immediate_next_step) ?? nullableString(record.public_summary);
  if (!source) return undefined;
  const oneLine = source.replace(/\s+/gu, " ").trim();
  const sentence = oneLine.split(/[.!?。！？]/u)[0]?.trim() || oneLine;
  return sentence.slice(0, 80);
}

function parseContinuityUpdates(value: unknown): ContinuityUpdate[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("continuity_updates_invalid");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("continuity_update_invalid_object");
    }
    const record = item as Record<string, unknown>;
    return {
      scope: record.scope as ContinuityUpdate["scope"],
      kind: record.kind as ContinuityUpdate["kind"],
      operation: record.operation as ContinuityUpdate["operation"],
      summary: typeof record.summary === "string" ? record.summary : "",
      ...(nullableString(record.target_ref) ? { target_ref: nullableString(record.target_ref) } : {}),
    };
  });
}

function renderContinuityCandidates(candidates: readonly ContinuityCandidate[]): string {
  if (candidates.length === 0) return "none";
  return candidates
    .map((candidate) => `${candidate.continuity_id} [${candidate.scope}/${candidate.kind}] ${candidate.summary}`)
    .join(" | ");
}
