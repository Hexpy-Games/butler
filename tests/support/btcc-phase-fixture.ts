import type {
  ModelInvocation,
} from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

const DEFAULT_CRITERION_ID = "requested-result-complete";

export interface BtccPhaseFixtureOptions {
  action?: "answer" | "inspect";
  answerText?: string;
  reportText?: string;
  publicTitle?: string;
  publicSummary?: string;
  requiredEffects?: string[];
  requiresCurrentState?: boolean;
  requiresTools?: boolean;
}

export function btccFixtureResponseForInvocation(
  input: ModelInvocation,
  options: BtccPhaseFixtureOptions = {},
): string {
  return btccFixtureResponse({
    prompt: input.messages.map((message) => message.content).join("\n\n"),
    responseFormat: input.responseFormat,
    options,
  });
}

export function btccFixtureResponse(input: {
  prompt: string;
  responseFormat?: {
    name: string;
    schema: Record<string, unknown>;
  };
  options?: BtccPhaseFixtureOptions;
}): string {
  const options = input.options ?? {};
  const name = input.responseFormat?.name;
  if (name === "butler_turn_contract_decision") {
    return JSON.stringify(conceptionDecision(input.responseFormat?.schema, options));
  }
  if (name === "butler_btcc_independent_review") {
    const evidenceRef = capsuleRef(input.prompt, "executionCandidateRef");
    return JSON.stringify({
      outcome: "passed",
      summary: "The execution candidate satisfies the requested result.",
      criterion_verdicts: [{
        criterion_id: DEFAULT_CRITERION_ID,
        status: "passed",
        evidence_refs: [evidenceRef],
      }],
      criterion_id: null,
      reason_code: null,
      required_change: null,
      evidence_refs: [evidenceRef],
    });
  }
  if (name === "butler_btcc_final_dossier") {
    const evidenceRef = capsuleRef(input.prompt, "reviewCandidateRef");
    return JSON.stringify({
      schema_version: "butler.btcc-final-dossier.v1",
      outcome: "complete",
      goal_coverage: [{
        criterion_id: DEFAULT_CRITERION_ID,
        status: "passed",
        evidence_refs: [evidenceRef],
      }],
      delivered_items: ["Requested result"],
      limitations: [],
      tracking_closeout: "Turn-local work is complete.",
      evidence_refs: [evidenceRef],
    });
  }
  if (name === "butler_btcc_report_candidate") {
    return JSON.stringify({
      report_text: options.reportText ?? options.answerText ?? "Requested result completed.",
      reporting_item_refs: capsuleStringArray(input.prompt, "requiredReportingItemRefs"),
      evidence_refs: capsuleStringArray(input.prompt, "admittedEvidenceRefs"),
    });
  }
  if (name === "butler_btcc_report_guard") {
    return JSON.stringify({
      outcome: "passed",
      summary: "The report is supported and complete.",
      reason_code: null,
      required_change: null,
      criterion_verdicts: [
        "factual_support",
        "requested_result_coverage",
        "safety",
        "clarity",
        "terminal_honesty",
        "tracking_closeout",
      ].map((criterion_id) => ({
        criterion_id,
        status: "passed",
        finding_code: null,
        required_change: null,
      })),
    });
  }
  throw new Error(`unexpected_btcc_fixture_response_format:${name ?? "none"}`);
}

function conceptionDecision(
  schema: Record<string, unknown> | undefined,
  options: BtccPhaseFixtureOptions,
): Record<string, unknown> {
  const action = options.action ?? "inspect";
  const answerText = action === "answer"
    ? options.answerText ?? options.reportText ?? "Requested result completed."
    : null;
  const requiresTools = options.requiresTools ?? action !== "answer";
  const requiresCurrentState = options.requiresCurrentState ?? action !== "answer";
  return {
    schema_version: "butler.turn-contract-decision.v1",
    decision_id: decisionId(schema),
    action,
    target_workstream_id: null,
    target_project_id: null,
    blocker_id: null,
    evidence_domain: null,
    inspection_scope: action === "answer" ? null : "workspace",
    deliverables: action === "answer" ? [] : ["status_report"],
    continuity_updates: [],
    answer_text: answerText,
    public_title: options.publicTitle ?? "요청 처리",
    public_summary: options.publicSummary ?? "요청한 결과를 확인하고 전달합니다.",
    public_rationale: "현재 요청의 계약과 증거를 기준으로 처리합니다.",
    immediate_next_step: action === "answer" ? null : "요청한 결과를 생성하고 검증합니다.",
    goal_contract_candidate: {
      requested_outcome: "Deliver the result requested in the current user message.",
      problem_frame: action === "answer"
        ? "This turn can be answered from admitted context."
        : "This turn requires managed execution and verified evidence.",
      intent_understanding: {
        user_request: "Complete the current user request.",
        related_context_refs: [],
        connected_knowledge_needs: [],
        user_preference_applications: [],
        expert_perspectives: ["relevant domain expert"],
        required_result: "A complete, truthful principal-facing result.",
      },
      binding_constraints: ["Do not claim evidence that was not observed."],
      non_goals: ["Do not expose internal reasoning."],
      acceptance_intents: [{
        key: DEFAULT_CRITERION_ID,
        statement: "The requested result is complete and supported by admitted evidence.",
        evidence_class: action === "answer" ? "admitted_context" : "validation",
      }],
      ambiguity_decisions: [],
      current_state_needs: requiresCurrentState ? ["Current execution state"] : [],
      evidence_needs: requiresTools ? ["Verified execution evidence"] : [],
      downstream_authority_needs: [],
      work_shape: {
        work_disposition: action === "answer" ? "direct_answer" : "managed_work",
        custody: "same_turn",
        required_effects: options.requiredEffects ?? (requiresTools ? ["observe"] : []),
        deliverable_kinds: [action === "answer" ? "answer" : "status_report"],
        requires_current_state: requiresCurrentState,
        requires_tools: requiresTools,
      },
    },
  };
}

function decisionId(schema: Record<string, unknown> | undefined): string {
  return String((schema as {
    properties?: { decision_id?: { const?: unknown } };
  } | undefined)?.properties?.decision_id?.const ?? "");
}

function capsuleRef(prompt: string, key: string): string {
  const marker = `"${key}":"`;
  const start = prompt.indexOf(marker);
  if (start < 0) throw new Error(`missing_capsule_ref:${key}`);
  const valueStart = start + marker.length;
  const end = prompt.indexOf('"', valueStart);
  if (end < 0) throw new Error(`invalid_capsule_ref:${key}`);
  return prompt.slice(valueStart, end);
}

function capsuleStringArray(prompt: string, key: string): string[] {
  const marker = `"${key}":`;
  const start = prompt.indexOf(marker);
  if (start < 0) throw new Error(`missing_capsule_array:${key}`);
  const arrayStart = prompt.indexOf("[", start + marker.length);
  const arrayEnd = prompt.indexOf("]", arrayStart);
  if (arrayStart < 0 || arrayEnd < 0) throw new Error(`invalid_capsule_array:${key}`);
  const value: unknown = JSON.parse(prompt.slice(arrayStart, arrayEnd + 1));
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`invalid_capsule_array:${key}`);
  }
  return value;
}
