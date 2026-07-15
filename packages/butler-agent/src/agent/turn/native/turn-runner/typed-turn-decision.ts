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
import type { GoalContractCandidateV1 } from "../../btcc/phase-types.ts";

export const TURN_DECISION_REPAIR_LIMIT = 1;

const DELIVERABLE_DECISION_GUIDANCE = [
  "Select only concrete output obligations required by the user's semantic objective.",
  "ledger_spec, ledger_plan, ledger_work, and ledger_tasks mean canonical Project Ledger records only.",
  "ledger_tasks never means the bound runtime todo plan created with update_todo_list.",
  "A request for a task list, todo list, work list, checklist, or explicit plan before execution does not by itself request ledger_tasks.",
  "Every work action receives its bound runtime todo plan independently of deliverables and tracking mode.",
  "Project-bound managed work uses canonical Project Ledger tracking before execution.",
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
    "## Conception Output Contract",
    "Return one strict structured Conception decision for the current user instruction.",
    `decision_id must be ${input.decisionId}.`,
    "This is the first productive semantic pass, not a separate classifier. Its accepted output becomes the immutable GoalContract for Planning.",
    "Account for six intent lenses: the current request, related admitted memories, connected knowledge or current reality, accepted user preferences, needed expert perspectives, and the exact required result.",
    "Populate goal_contract_candidate from those six lenses and an evidence-oriented work shape. Do not copy hidden context or raw profile material.",
    "If one material fact must be observed before the intent can be finalized, set intent_grounding_observation to one typed evidence need. It requests a read-only capability by purpose and scope, never by tool name. Set it to null once the GoalContract is ready.",
    "Do not use intent_grounding_observation for implementation, mutation, validation of work not yet executed, or facts that Planning/Execution should own.",
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
    "Use ledger_spec, ledger_plan, ledger_work, or ledger_tasks only when the semantic objective requires canonical Project Ledger records or the selected compatible WorkStream already has unsatisfied Ledger obligations.",
    "Project binding is structural. Managed work in an active project must use canonical Project Ledger tracking before Execution; a direct answer with no work obligation remains turn-local.",
    "In an active project, local commands, files, tests, operational checks, and non-coding deliverables are governed by the Ledger when they create a work obligation.",
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
  relatedContextRefs?: readonly string[];
  adaptationHintRefs?: readonly string[];
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
        "blocker_id", "evidence_domain", "inspection_scope", "deliverables", "continuity_updates", "answer_text", "public_title", "public_summary", "public_rationale", "immediate_next_step", "goal_contract_candidate",
      ],
      properties: {
        schema_version: { type: "string", const: TURN_CONTRACT_DECISION_SCHEMA },
        decision_id: { type: "string", const: input.decisionId },
        action: { type: "string", enum: [...TURN_CONTRACT_ACTIONS] },
        target_workstream_id: { enum: [null, ...input.candidateIds] },
        target_project_id: {
          description: "The active project target. Managed work bound to it uses canonical Project Ledger tracking.",
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
        goal_contract_candidate: goalContractCandidateSchema(input),
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
    goal_contract_candidate: parseGoalContractCandidate(record.goal_contract_candidate),
  });
}

function goalContractCandidateSchema(input: {
  relatedContextRefs?: readonly string[];
  adaptationHintRefs?: readonly string[];
}): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "requested_outcome", "problem_frame", "intent_understanding",
      "binding_constraints", "non_goals", "acceptance_intents",
      "ambiguity_decisions", "current_state_needs", "evidence_needs",
      "downstream_authority_needs", "work_shape", "intent_grounding_observation",
    ],
    properties: {
      requested_outcome: { type: "string", minLength: 1, maxLength: 1000 },
      problem_frame: { type: "string", minLength: 1, maxLength: 1600 },
      intent_understanding: {
        type: "object",
        additionalProperties: false,
        required: [
          "user_request", "related_context_refs", "connected_knowledge_needs",
          "user_preference_applications", "expert_perspectives", "required_result",
        ],
        properties: {
          user_request: { type: "string", minLength: 1, maxLength: 1000 },
          related_context_refs: {
            type: "array",
            uniqueItems: true,
            items: allowedRefSchema(input.relatedContextRefs),
          },
          connected_knowledge_needs: stringArraySchema(12, 500),
          user_preference_applications: {
            type: "array",
            maxItems: 12,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["hint_ref", "application"],
              properties: {
                hint_ref: allowedRefSchema(input.adaptationHintRefs),
                application: { type: "string", minLength: 1, maxLength: 500 },
              },
            },
          },
          expert_perspectives: stringArraySchema(12, 300),
          required_result: { type: "string", minLength: 1, maxLength: 1000 },
        },
      },
      binding_constraints: stringArraySchema(20, 500),
      non_goals: stringArraySchema(20, 500),
      acceptance_intents: {
        type: "array",
        minItems: 1,
        maxItems: 30,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "statement", "evidence_class"],
          properties: {
            key: { type: "string", minLength: 1, maxLength: 120 },
            statement: { type: "string", minLength: 1, maxLength: 800 },
            evidence_class: {
              type: "string",
              enum: ["admitted_context", "current_state", "artifact", "validation", "user_confirmation"],
            },
          },
        },
      },
      ambiguity_decisions: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["issue", "decision", "basis", "source_refs"],
          properties: {
            issue: { type: "string", minLength: 1, maxLength: 500 },
            decision: { type: "string", minLength: 1, maxLength: 800 },
            basis: {
              type: "string",
              enum: ["current_user_message", "canonical_project_contract", "accepted_prior_decision", "fallible_context"],
            },
            source_refs: { type: "array", uniqueItems: true, items: { type: "string" } },
          },
        },
      },
      current_state_needs: stringArraySchema(20, 500),
      evidence_needs: stringArraySchema(30, 500),
      downstream_authority_needs: stringArraySchema(20, 500),
      work_shape: {
        type: "object",
        additionalProperties: false,
        required: [
          "work_disposition", "custody", "required_effects", "deliverable_kinds",
          "requires_current_state", "requires_tools",
        ],
        properties: {
          work_disposition: { type: "string", enum: ["direct_answer", "managed_work"] },
          custody: { type: "string", enum: ["same_turn", "durable"] },
          required_effects: stringArraySchema(20, 200),
          deliverable_kinds: stringArraySchema(20, 200),
          requires_current_state: { type: "boolean" },
          requires_tools: { type: "boolean" },
        },
      },
      intent_grounding_observation: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: [
              "evidence_need_id", "goal_field", "question", "why_material",
              "source_scope_refs", "expected_resolution",
            ],
            properties: {
              evidence_need_id: { type: "string", minLength: 1, maxLength: 160 },
              goal_field: {
                type: "string",
                enum: [
                  "referent", "requested_outcome", "scope", "constraint",
                  "authority", "acceptance",
                ],
              },
              question: { type: "string", minLength: 1, maxLength: 800 },
              why_material: { type: "string", minLength: 1, maxLength: 800 },
              source_scope_refs: {
                type: "array",
                maxItems: 20,
                uniqueItems: true,
                items: { type: "string", minLength: 1, maxLength: 240 },
              },
              expected_resolution: { type: "string", minLength: 1, maxLength: 800 },
            },
          },
          { type: "null" },
        ],
      },
    },
  };
}

function stringArraySchema(maxItems: number, maxLength: number): Record<string, unknown> {
  return {
    type: "array",
    maxItems,
    items: { type: "string", minLength: 1, maxLength },
  };
}

function allowedRefSchema(refs: readonly string[] | undefined): Record<string, unknown> {
  return refs && refs.length > 0
    ? { type: "string", enum: [...refs] }
    : { type: "string", minLength: 1 };
}

function parseGoalContractCandidate(value: unknown): GoalContractCandidateV1 | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("btcc_goal_contract_candidate_invalid");
  }
  const record = value as Record<string, unknown>;
  const understanding = requiredRecord(
    record.intent_understanding,
    "btcc_goal_contract_intent_understanding_invalid",
  );
  const workShape = requiredRecord(
    record.work_shape,
    "btcc_goal_contract_work_shape_invalid",
  );
  return {
    requestedOutcome: requiredCandidateString(record.requested_outcome),
    problemFrame: requiredCandidateString(record.problem_frame),
    intentUnderstanding: {
      userRequest: requiredCandidateString(understanding.user_request),
      relatedContextRefs: stringArray(understanding.related_context_refs),
      connectedKnowledgeNeeds: stringArray(understanding.connected_knowledge_needs),
      userPreferenceApplications: recordArray(understanding.user_preference_applications).map((item) => ({
        hintRef: requiredCandidateString(item.hint_ref),
        application: requiredCandidateString(item.application),
      })),
      expertPerspectives: stringArray(understanding.expert_perspectives),
      requiredResult: requiredCandidateString(understanding.required_result),
    },
    bindingConstraints: stringArray(record.binding_constraints),
    nonGoals: stringArray(record.non_goals),
    acceptanceIntents: recordArray(record.acceptance_intents).map((item) => ({
      key: requiredCandidateString(item.key),
      statement: requiredCandidateString(item.statement),
      evidenceClass: item.evidence_class as GoalContractCandidateV1["acceptanceIntents"][number]["evidenceClass"],
    })),
    ambiguityDecisions: recordArray(record.ambiguity_decisions).map((item) => ({
      issue: requiredCandidateString(item.issue),
      decision: requiredCandidateString(item.decision),
      basis: item.basis as GoalContractCandidateV1["ambiguityDecisions"][number]["basis"],
      sourceRefs: stringArray(item.source_refs),
    })),
    currentStateNeeds: stringArray(record.current_state_needs),
    evidenceNeeds: stringArray(record.evidence_needs),
    downstreamAuthorityNeeds: stringArray(record.downstream_authority_needs),
    workShape: {
      workDisposition: workShape.work_disposition as GoalContractCandidateV1["workShape"]["workDisposition"],
      custody: workShape.custody as GoalContractCandidateV1["workShape"]["custody"],
      requiredEffects: stringArray(workShape.required_effects),
      deliverableKinds: stringArray(workShape.deliverable_kinds),
      requiresCurrentState: workShape.requires_current_state === true,
      requiresTools: workShape.requires_tools === true,
    },
    ...parseIntentGroundingObservation(record.intent_grounding_observation),
  };
}

function parseIntentGroundingObservation(
  value: unknown,
): Pick<GoalContractCandidateV1, "intentGroundingObservation"> {
  if (value === null || value === undefined) return {};
  const record = requiredRecord(value, "btcc_intent_grounding_observation_invalid");
  const goalField = record.goal_field;
  if (![
    "referent", "requested_outcome", "scope", "constraint", "authority", "acceptance",
  ].includes(String(goalField))) {
    throw new Error("btcc_intent_grounding_observation_goal_field_invalid");
  }
  return {
    intentGroundingObservation: {
      evidenceNeedId: requiredCandidateString(record.evidence_need_id),
      goalField: goalField as NonNullable<
        GoalContractCandidateV1["intentGroundingObservation"]
      >["goalField"],
      question: requiredCandidateString(record.question),
      whyMaterial: requiredCandidateString(record.why_material),
      sourceScopeRefs: stringArray(record.source_scope_refs),
      expectedResolution: requiredCandidateString(record.expected_resolution),
    },
  };
}

function requiredRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("btcc_goal_contract_candidate_array_invalid");
  return value.map((item) => requiredRecord(item, "btcc_goal_contract_candidate_item_invalid"));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("btcc_goal_contract_candidate_string_array_invalid");
  }
  return value.map((item) => String(item).trim());
}

function requiredCandidateString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("btcc_goal_contract_candidate_string_invalid");
  }
  return value.trim();
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
  projectLedgerBound?: boolean;
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
  const targetedDecision = input.projectId?.trim() && !input.decision.target_project_id && attachesProjectTarget
    ? { ...input.decision, target_project_id: input.projectId.trim() }
    : input.decision;
  const decision = input.projectLedgerBound === true && targetedDecision.target_project_id &&
      ["start_work", "modify_work"].includes(targetedDecision.action)
    ? {
      ...targetedDecision,
      deliverables: [...new Set([
        "ledger_spec" as const,
        "ledger_plan" as const,
        "ledger_work" as const,
        "ledger_tasks" as const,
        ...targetedDecision.deliverables,
      ])],
    }
    : targetedDecision;
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
