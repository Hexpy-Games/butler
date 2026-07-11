import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import { join } from "path";
import { readJsonFile } from "../../../persistence/atomic-json-store.ts";
import {
  enforceGroundedActionClaims,
  hasSuccessfulTool,
  requiredExplicitToolNames,
  shouldEnforceGrounding,
} from "../../../policy/runtime-policy.ts";
import { evaluateCompletionReviewOutcome, type CompletionReviewOutcome } from "../../completion-review.ts";
import { requiredCompletionObligations } from "../../../output/completion/obligation-review.ts";
import {
  hasGoalCompletionReviewSkipTool,
} from "../policy/turn-evidence-gates.ts";
import { shouldRunGoalCompletionReview } from "../policy/turn-metadata-policy.ts";
import type { NativeStoredSessionConfig, NativeTurnRunnerDeps } from "./turn-runner-types.ts";
import type { PublicWorkDecision, PublicWorkObligationKind, ToolAuditEntry } from "../output/tool-types.ts";
import type { ToolSurfacePromptController } from "../../tool-surface-prompt-controller.ts";
import {
  applyPublicOutputGuards,
  repairFinalContract,
} from "./public-output-gates.ts";
import { emitTurnEventBestEffort } from "../progress/turn-delivery-events.ts";
import type { createDirectTurnBudget } from "../../direct-turn-budget.ts";
import { WorkStreamStore } from "../../../work/work-stream.ts";
import { TodoListStore } from "../../../work/todo-list.ts";
import { safePublicText } from "../../../output/evidence/transcript-sanitizers.ts";
import {
  canDeliverTurnContract,
  evaluateTurnContractPlanClosure,
  turnContractPlanAllowsTerminal,
  TurnContractStore,
  type CompiledTurnContract,
  type TurnCancellationReceipt,
} from "../../turn-contract.ts";
import {
  recordTurnContractAuditEvidence,
  unsatisfiedTurnContractObligations,
} from "./turn-contract-audit-evidence.ts";
import { buildTurnContinuationEvidence } from "./turn-continuation-evidence.ts";
import { statusReportEvidenceGuidance } from "./turn-contract-status-evidence.ts";

export type FinalDeliveryOutcome =
  | { kind: "final"; text: string; evidenceRefs: string[] }
  | {
      kind: "completion_gap";
      observation: {
        kind: string;
        summary: string;
        modelVisibleContent: string;
        nextMode?: "tool_decision" | "final_synthesis";
        refs?: Array<{ kind: string; id: string; path?: string }>;
        requiredDeliverables?: string[];
      };
      evidenceRefs: string[];
    };

type FinalDeliveryReviewInput = {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  deps: NativeTurnRunnerDeps;
  useTools: boolean;
  turnId?: string | null;
  turnBudget: ReturnType<typeof createDirectTurnBudget>;
  prompt: string;
  userText: string;
  initialText: string;
  audit: ToolAuditEntry[];
  publicDecisionContext: PublicWorkDecision[];
  toolSurfaceController: ToolSurfacePromptController;
  turnContract?: CompiledTurnContract;
};

export type FinalCandidateContinuationReviewOutcome =
  | { kind: "accepted"; text: string; evidenceRefs: string[] }
  | Extract<FinalDeliveryOutcome, { kind: "completion_gap" }>;

export async function produceFinalDeliveryOutcome(
  input: FinalDeliveryReviewInput,
): Promise<FinalDeliveryOutcome> {
  const review = await reviewFinalCandidateForContinuation(input);
  if (review.kind === "completion_gap") return review;
  const contractRepairedText = repairFinalContract({ ...input, finalText: review.text });
  await emitTurnEventBestEffort(input.turnInput, {
    kind: "guard.started",
    payload: { guard: "public_output" },
  });
  const checkedText = applyPublicOutputGuards({ ...input, finalText: contractRepairedText });
  await emitTurnEventBestEffort(input.turnInput, {
    kind: "guard.completed",
    payload: { guard: "public_output", status: "approved" },
  });
  return { kind: "final", text: checkedText, evidenceRefs: review.evidenceRefs };
}

export async function reviewFinalCandidateForContinuation(
  input: FinalDeliveryReviewInput,
): Promise<FinalCandidateContinuationReviewOutcome> {
  const explicitToolGap = explicitToolRequirementGap(input);
  if (explicitToolGap) return explicitToolGap;
  const groundedText = applyGroundingIfNeeded(input, input.initialText);
  const reviewResult = await runGoalCompletionReviews({ ...input, initialText: groundedText });
  if (reviewResult.outcome.status === "gap") {
    return {
      kind: "completion_gap",
      observation: reviewResult.outcome.observation,
      evidenceRefs: reviewResult.outcome.evidenceRefs,
    };
  }
  if (input.turnContract) {
    const planClosure = evaluateTurnContractPlanClosure({
      butlerData: input.deps.butlerData,
      contract: input.turnContract,
    });
    const contract = recordTurnContractAuditEvidence({
      butlerData: input.deps.butlerData,
      contract: input.turnContract,
      audit: input.audit,
      finalCandidate: reviewResult.reviewedText,
      runtimeReviewCompleted: reviewResult.performed,
      planClosureSatisfied: turnContractPlanAllowsTerminal(planClosure),
    });
    if (planClosure.status === "invalid") {
      throw new Error(planClosure.code);
    }
    const store = new TurnContractStore(input.deps.butlerData);
    if (planClosure.status === "incomplete") {
      const missing = unsatisfiedTurnContractObligations({
        butlerData: input.deps.butlerData,
        contract,
      }).filter((item) => item.deliverable !== "final_report");
      return planClosureGap(planClosure, contract.evidence_receipt_ids, missing);
    }
    const gate = canDeliverTurnContract({
      contract,
      evidenceReceipts: store.evidenceFor(contract),
      cancellationReceipt: contract.cancellation_receipt_id
        ? cancellationReceipt(input.deps.butlerData, contract.cancellation_receipt_id)
        : null,
    });
    if (gate !== "deliver") {
      const unsatisfied = unsatisfiedTurnContractObligations({
        butlerData: input.deps.butlerData,
        contract,
      });
      const missing = actionableContractObligations(unsatisfied);
      return {
        kind: "completion_gap",
        observation: {
          kind: "turn_contract_incomplete",
          summary: `Typed turn contract still has ${missing.length} unsatisfied obligation(s).`,
          modelVisibleContent: [
            "Continue the same logical turn. The typed turn contract is not complete.",
            "Satisfy these structured deliverables before final delivery:",
            ...missing.map((item) => `- ${item.deliverable}:${item.target_kind}:${item.target_id}`),
            ...(missing.some((item) => item.deliverable === "status_report")
              ? statusReportEvidenceGuidance()
              : []),
            ...(unsatisfied.some((item) => item.deliverable === "final_report")
              ? ["The current final candidate already supplies final_report. Do not create a report record or file; submit a new final candidate after the listed non-report work is complete."]
              : []),
            "Do not ask the user unless a verified user-owned blocker receipt exists.",
          ].join("\n"),
          refs: missing.map((item) => ({ kind: "turn_contract_obligation", id: item.obligation_id })),
          requiredDeliverables: [...new Set(missing.map((item) => item.deliverable))],
        },
        evidenceRefs: contract.evidence_receipt_ids,
      };
    }
  }
  return {
    kind: "accepted",
    text: reviewResult.reviewedText,
    evidenceRefs: reviewResult.outcome.evidenceRefs,
  };
}

function planClosureGap(
  closure: ReturnType<typeof evaluateTurnContractPlanClosure>,
  evidenceRefs: string[],
  missingDeliverables: Array<{
    deliverable: string;
    target_kind: string;
    target_id: string;
    obligation_id: string;
  }>,
): Extract<FinalDeliveryOutcome, { kind: "completion_gap" }> {
  const openItems = closure.status === "incomplete" ? closure.open_items.slice(0, 12) : [];
  const totalOpenItems = closure.status === "incomplete" ? closure.open_items.length : 0;
  return {
    kind: "completion_gap",
    observation: {
      kind: "turn_contract_plan_incomplete",
      summary: totalOpenItems > 0
        ? `The bound work plan still has ${totalOpenItems} open non-reporting item(s).`
        : "The bound work plan is not currently resolvable for terminal delivery.",
      modelVisibleContent: [
        "Continue the same logical turn. The contract-bound work plan is not complete yet.",
        "Finish the retained items below, then update the bound todo list with their structured statuses.",
        ...openItems.map((item) => `- ${item.id}: status=${item.status}; phase=${item.phase ?? "none"}`),
        ...(missingDeliverables.length > 0
          ? [
              "The following typed deliverables also still need evidence:",
              ...missingDeliverables.map((item) => `- ${item.deliverable}:${item.target_kind}:${item.target_id}`),
              ...(missingDeliverables.some((item) => item.deliverable === "status_report")
                ? statusReportEvidenceGuidance()
                : []),
            ]
          : []),
        "Keep moving through those structured items in dependency order and submit a new final candidate after they are complete.",
        "A verified user-owned blocker may change the state to waiting_user; otherwise continue autonomously.",
      ].join("\n"),
      refs: [
        ...openItems.map((item) => ({ kind: "workstream_todo", id: item.id })),
        ...missingDeliverables.map((item) => ({ kind: "turn_contract_obligation", id: item.obligation_id })),
      ],
      requiredDeliverables: [...new Set(missingDeliverables.map((item) => item.deliverable))],
    },
    evidenceRefs,
  };
}

function actionableContractObligations<T extends { deliverable: string }>(obligations: T[]): T[] {
  const withoutFinalReport = obligations.filter((item) => item.deliverable !== "final_report");
  return withoutFinalReport.length > 0 ? withoutFinalReport : obligations;
}

function cancellationReceipt(butlerData: string, receiptId: string) {
  return readJsonFile<TurnCancellationReceipt>(
    join(butlerData, "workstream-claim-receipts", `${safeContractId(receiptId)}.json`),
  );
}

function safeContractId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw new Error("turn_contract_unsafe_receipt_id");
  return value;
}

function applyGroundingIfNeeded(
  input: {
    turnInput: RuntimeTurnInput;
    deps: NativeTurnRunnerDeps;
    useTools: boolean;
    userText: string;
    audit: ToolAuditEntry[];
  },
  text: string,
): string {
  const shouldApplyGrounding = input.useTools && shouldEnforceGrounding(input.turnInput);
  if (!shouldApplyGrounding) {
    return text;
  }
  return enforceGroundedActionClaims({
    userText: input.userText,
    responseText: text,
    audit: input.audit,
    language: input.deps.messageLanguage,
  });
}

function explicitToolRequirementGap(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  useTools: boolean;
  audit: ToolAuditEntry[];
  toolSurfaceController: ToolSurfacePromptController;
}): Extract<FinalDeliveryOutcome, { kind: "completion_gap" }> | null {
  if (!input.useTools) {
    return null;
  }
  const explicitTools = requiredExplicitToolNames(
    [input.session.init.metadata, input.turnInput.metadata],
    input.toolSurfaceController.initialToolNames(),
  );
  const missingExplicitTools = explicitTools.filter((toolName) =>
    !hasSuccessfulTool(input.audit, [toolName]));
  if (missingExplicitTools.length === 0) {
    return null;
  }
  return {
    kind: "completion_gap",
    observation: {
      kind: "completion_gap",
      summary: `Missing required tool execution: ${missingExplicitTools.join(", ")}`,
      modelVisibleContent: [
        "The current turn has not executed all explicitly required native tools.",
        "Continue the same logical turn by selecting the missing required tool(s) through the normal tool path.",
        "Do not deliver final text until these tool observations exist.",
        "Missing required tools:",
        ...missingExplicitTools.map((toolName) => `- ${toolName}`),
      ].join("\n"),
      refs: missingExplicitTools.map((toolName) => ({ kind: "tool", id: toolName })),
    },
    evidenceRefs: [],
  };
}

async function runGoalCompletionReviews(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  deps: NativeTurnRunnerDeps;
  useTools: boolean;
  turnId?: string | null;
  prompt: string;
  initialText: string;
  audit: ToolAuditEntry[];
  publicDecisionContext: PublicWorkDecision[];
}): Promise<{
  outcome: ReturnType<typeof evaluateCompletionReviewOutcome>;
  reviewedText: string;
  performed: boolean;
}> {
  const shouldReview = shouldRunCompletionReview(input);
  if (!shouldReview) {
    return {
      outcome: {
        status: "complete",
        evidenceRefs: [],
      },
      reviewedText: input.initialText,
      performed: false,
    };
  }
  const requiredObligations = requiredCompletionObligations(input.publicDecisionContext);
  const outcome = evaluateCompletionReviewOutcome({
    requestText: input.prompt,
    candidateText: input.initialText,
    evidenceReceipts: [
      ...evidenceCapabilityReceiptsFromAudit(input.audit),
      ...modelReviewedSourceEvidenceReceipts({
        audit: input.audit,
        requiredObligations,
        publicDecisionContext: input.publicDecisionContext,
        candidateText: input.initialText,
      }),
    ],
    requiredObligations,
    observations: observationsFromAudit(input.audit),
  });
  return {
    outcome: outcome.status === "gap"
      ? withCompletionGapEvidenceBundle({
        outcome,
        audit: input.audit,
      })
      : outcome,
    reviewedText: input.initialText,
    performed: true,
  };
}

function shouldRunCompletionReview(
  input: {
    turnInput: RuntimeTurnInput;
    session: NativeStoredSessionConfig;
    useTools: boolean;
    audit: ToolAuditEntry[];
  },
): boolean {
  if (!input.useTools || !shouldEnforceGrounding(input.turnInput)) {
    return false;
  }
  if (!shouldRunGoalCompletionReview(input.turnInput.metadata, input.session.init.role)) {
    return false;
  }
  if (hasGoalCompletionReviewSkipTool(input.audit)) {
    return false;
  }
  return input.audit.some((entry) => entry.ok);
}

function evidenceCapabilityReceiptsFromAudit(audit: ToolAuditEntry[]): unknown[] {
  return audit.flatMap((entry) => [
    ...(entry.evidenceCapabilityReceipts ?? []),
    ...legacyEvidenceReceiptsAsCapabilityReceipts(entry),
    ...satisfiedObligationsAsCapabilityReceipts(entry),
  ]);
}

function modelReviewedSourceEvidenceReceipts(input: {
  audit: ToolAuditEntry[];
  requiredObligations: PublicWorkObligationKind[];
  publicDecisionContext: PublicWorkDecision[];
  candidateText: string;
}): unknown[] {
  if (!input.requiredObligations.includes("source_verified")) return [];
  if (!input.candidateText.trim()) return [];
  if (hasPrincipalAuthoredSourceRequirement(input.publicDecisionContext)) return [];
  const summaries = reviewableSourceEvidenceSummaries(input.audit);
  if (summaries.length === 0) return [];
  return [{
    receipt_id: `runtime:model-reviewed-source:${stableTextHash(summaries.map((summary) => summary.fingerprint).join("|"))}`,
    schema_version: "evidence-capability.v1",
    producer: { kind: "runtime", name: "completion-review" },
    capability: "source_verified",
    evidence_kind: "review_result",
    maturity: "verified",
    confidence: 0.75,
    verified: true,
    summary: "The final candidate was reviewed against bounded source evidence from observed tool results.",
    references: summaries.slice(0, 6).map((summary) => ({ tool_call_id: summary.id })),
    satisfies: ["source_verified"],
    limitations: summaries.some((summary) => summary.truncated)
      ? ["One or more source evidence previews were bounded before review."]
      : [],
    created_at: new Date(0).toISOString(),
  }];
}

function hasPrincipalAuthoredSourceRequirement(decisions: PublicWorkDecision[]): boolean {
  return decisions.some((decision) =>
    decision.source === "principal-authored" &&
    (decision.completionObligations ?? []).includes("source_verified"));
}

function withCompletionGapEvidenceBundle(input: {
  outcome: CompletionReviewOutcome;
  audit: ToolAuditEntry[];
}): CompletionReviewOutcome {
  if (input.outcome.status !== "gap") return input.outcome;
  const bundle = completionGapEvidenceBundle(input.audit);
  if (!bundle) return input.outcome;
  const instructions = [
    "",
    "recent-reviewable-evidence:",
    bundle,
    ...completionGapStagnationAdvisory(input.audit),
    "",
    "review-guidance:",
    "- A butler_evidence_packet is a pointer to omitted raw evidence, not itself a final source. If a claim depends on omitted packet evidence, call read_tool_evidence_artifact for an exact bounded slice before finalizing.",
    "- source_verified is a semantic obligation. If the bounded evidence above contains the source facts needed for the answer, use it and finalize the turn.",
    "- If the evidence is insufficient, choose a tool or artifact path that can add different evidence. Repeating the same call is useful only when the underlying state is expected to change.",
    "- If no available tool can advance the missing evidence, answer with INCOMPLETE and a concise limitation.",
  ];
  return {
    ...input.outcome,
    observation: {
      ...input.outcome.observation,
      modelVisibleContent: [
        input.outcome.observation.modelVisibleContent,
        ...instructions,
      ].join("\n"),
    },
  };
}

interface ReviewableSourceEvidenceSummary {
  id: string;
  fingerprint: string;
  line: string;
  truncated: boolean;
}

function completionGapEvidenceBundle(audit: ToolAuditEntry[]): string | null {
  const summaries = reviewableSourceEvidenceSummaries(audit);
  if (summaries.length === 0) return null;
  return summaries
    .slice(-4)
    .map((summary) => `- ${summary.line}`)
    .join("\n");
}

function reviewableSourceEvidenceSummaries(audit: ToolAuditEntry[]): ReviewableSourceEvidenceSummary[] {
  return audit
    .map((entry, index) => reviewableSourceEvidenceSummary(entry, index))
    .filter((summary): summary is ReviewableSourceEvidenceSummary => Boolean(summary));
}

function reviewableSourceEvidenceSummary(
  entry: ToolAuditEntry,
  index: number,
): ReviewableSourceEvidenceSummary | null {
  if (!entry.ok) return null;
  if (entry.name === "web_search") return null;
  const preview = sourceEvidencePreview(entry.result);
  if (!preview) return null;
  const id = `audit:${index + 1}:${entry.name}`;
  const args = boundedJson(entry.args, 240);
  const fingerprint = stableTextHash(`${entry.name}\n${args}\n${preview.text}`);
  return {
    id,
    fingerprint,
    truncated: preview.truncated,
    line: [
      `${id}`,
      `tool=${entry.name}`,
      `args=${args}`,
      `preview=${preview.text}`,
      preview.truncated ? "(bounded)" : "",
    ].filter(Boolean).join(" "),
  };
}

function sourceEvidencePreview(result: unknown): { text: string; truncated: boolean } | null {
  const record = recordValue(result);
  if (!record) return null;
  const textParts = [
    stringValue(record.stdout),
    stringValue(record.stderr),
    stringValue(record.content),
    stringValue(record.text),
    stringValue(record.body),
    stringValue(record.summary),
  ].filter((value): value is string => Boolean(value));
  const artifactParts = [
    ...artifactPreviewValues(record.butler_tool_artifact),
    ...artifactPreviewValues(record.verified_output_files),
    ...artifactPreviewValues(record.written_files),
    ...artifactPreviewValues(record.artifact_labels),
  ];
  const combined = [...textParts, ...artifactParts.map((artifact) => `artifact:${artifact}`)]
    .map((value) => value.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join(" | ");
  if (!combined) return null;
  return boundedText(safePublicText(combined, "Tool output contained private details."), 900);
}

function artifactPreviewValues(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value.flatMap((item) => artifactPreviewValues(item));
  const record = recordValue(value);
  if (!record) return [];
  return [
    stringValue(record.path),
    stringValue(record.label),
    stringValue(record.artifact_label),
    stringValue(record.artifact_id),
  ].filter((item): item is string => Boolean(item));
}

function completionGapStagnationAdvisory(audit: ToolAuditEntry[]): string[] {
  const groups = new Map<string, { count: number; latestTool: string }>();
  for (const entry of audit) {
    if (!entry.ok) continue;
    const preview = sourceEvidencePreview(entry.result);
    if (!preview) continue;
    const key = `${entry.name}\n${boundedJson(entry.args, 400)}\n${preview.text}`;
    const current = groups.get(key) ?? { count: 0, latestTool: entry.name };
    current.count += 1;
    current.latestTool = entry.name;
    groups.set(key, current);
  }
  const repeated = [...groups.values()].filter((group) => group.count >= 2);
  if (repeated.length === 0) return [];
  return [
    "",
    "stagnation-advisory:",
    ...repeated.slice(-3).map((group) =>
      `- ${group.latestTool} returned the same relevant evidence ${group.count} times in this turn. This is advisory only; repeat it only if the underlying state is expected to change.`,
    ),
  ];
}

function boundedText(value: string, maxChars: number): { text: string; truncated: boolean } {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return { text: value, truncated: false };
  return {
    text: `...${chars.slice(-maxChars).join("")}`,
    truncated: true,
  };
}

function boundedJson(value: unknown, maxChars: number): string {
  try {
    return boundedText(JSON.stringify(value) ?? "{}", maxChars).text;
  } catch {
    return "{}";
  }
}

function stableTextHash(value: string): string {
  let hash = 5381;
  for (const char of value) {
    hash = ((hash << 5) + hash + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function legacyEvidenceReceiptsAsCapabilityReceipts(entry: ToolAuditEntry): unknown[] {
  return (entry.evidenceReceipts ?? []).flatMap((receipt) =>
    (receipt.satisfies ?? []).map((obligation) => ({
      receipt_id: receipt.id,
      schema_version: "evidence-capability.v1",
      producer: receipt.producer,
      capability: obligation,
      evidence_kind: capabilityEvidenceKind(obligation),
      maturity: receipt.verified ? "verified" : "candidate",
      confidence: receipt.verified ? 0.9 : 0.3,
      verified: receipt.verified,
      summary: receipt.summary,
      references: receipt.references.map((reference) => ({
        ...(reference.kind === "url" ? { url: reference.ref } : {}),
        ...(reference.kind === "artifact" || reference.kind === "project_document" ? { path: reference.ref } : {}),
        ...(reference.kind === "tool_output" ? { tool_call_id: reference.ref } : {}),
      })),
      satisfies: [obligation],
      limitations: [],
      created_at: new Date(0).toISOString(),
    })));
}

function satisfiedObligationsAsCapabilityReceipts(entry: ToolAuditEntry): unknown[] {
  return (entry.satisfiedCompletionObligations ?? []).map((obligation) => ({
    receipt_id: `audit:${entry.name}:${obligation}`,
    schema_version: "evidence-capability.v1",
    producer: { kind: "tool", name: entry.name },
    capability: obligation,
    evidence_kind: capabilityEvidenceKind(obligation),
    maturity: entry.ok ? "verified" : "candidate",
    confidence: entry.ok ? 0.9 : 0.3,
    verified: entry.ok,
    summary: `${entry.name} satisfied ${obligation}.`,
    references: [],
    satisfies: [obligation],
    limitations: [],
    created_at: new Date(0).toISOString(),
  }));
}

function capabilityEvidenceKind(obligation: string): string {
  if (obligation === "source_verified") return "workspace_inspection";
  if (obligation === "command_executed") return "execution_result";
  if (obligation === "durable_artifact") return "artifact";
  if (obligation === "data_table_created") return "data_table";
  if (obligation === "chart_rendered") return "chart";
  return "project_state";
}

function observationsFromAudit(audit: ToolAuditEntry[]) {
  return audit
    .filter((entry) => !entry.ok)
    .map((entry) => {
      if (entry.observation) {
        return {
          kind: entry.observation.kind,
          summary: entry.observation.summary,
          modelVisibleContent: entry.observation.modelVisibleContent,
          visibility: entry.observation.visibility,
          publicSummary: entry.observation.publicSummary,
        };
      }
      const safeError = entry.error
        ? safePublicText(entry.error, "Tool execution failed with redacted private details.")
        : null;
      const message = safeError ? `${entry.name}: ${safeError}` : `${entry.name} failed.`;
      return {
        kind: "tool_result" as const,
        summary: message,
        modelVisibleContent: message,
        visibility: "model" as const,
      };
    });
}

export function collectTurnContinuationRefs(input: {
  butlerData: string;
  sessionId: string;
  turnId: string;
  audit: ToolAuditEntry[];
  publicDecisionContext: PublicWorkDecision[];
}): {
  latestAssistantDecision?: { id: string };
  openToolPairs: Array<{ kind: string; id: string; path?: string }>;
  evidenceCandidates: Array<{ kind: string; id: string; path?: string }>;
  currentTurnWork: Array<{ kind: string; id: string; path?: string }>;
  currentTurnTodos: Array<{ kind: string; id: string; path?: string }>;
} {
  const workStore = new WorkStreamStore(input.butlerData);
  const todoStore = new TodoListStore(input.butlerData);
  const currentTurnWork = workStore.list({
    sessionId: input.sessionId,
    includeTerminal: true,
  })
    .map((summary) => workStore.read(summary.id))
    .filter((record) => record?.last_user_turn_id === input.turnId)
    .map((record) => ({ kind: "work_stream", id: record!.id }));
  const currentTurnTodos = currentTurnWork.flatMap((work) => {
    const record = workStore.read(work.id);
    if (!record?.todo_list_id) return [];
    const todo = todoStore.read(record.todo_list_id);
    if (!todo) return [{ kind: "todo_list", id: record.todo_list_id }];
    return [
      { kind: "todo_list", id: todo.list_id },
      ...todo.items.map((item) => ({ kind: "todo_item", id: `${todo.list_id}:${item.id}` })),
    ];
  });
  const openToolPairs = input.audit
    .filter((entry) => !entry.ok)
    .map((entry, index) => ({ kind: "tool_pair", id: `audit:${index}:${entry.name}` }));
  const latestAssistantDecision = input.publicDecisionContext.at(-1)?.decisionId;
  const evidenceCandidates = buildTurnContinuationEvidence({
    audit: input.audit,
    publicDecisions: input.publicDecisionContext,
  }).refs;
  return {
    ...(latestAssistantDecision ? { latestAssistantDecision: { id: latestAssistantDecision } } : {}),
    openToolPairs,
    evidenceCandidates,
    currentTurnWork,
    currentTurnTodos,
  };
}
