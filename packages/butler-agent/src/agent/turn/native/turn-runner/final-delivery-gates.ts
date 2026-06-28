import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import {
  enforceGroundedActionClaims,
  explicitToolRequirementRepairPrompt,
  hasSuccessfulTool,
  requiredExplicitToolNames,
  shouldEnforceGrounding,
} from "../../../policy/runtime-policy.ts";
import { evaluateCompletionReviewOutcome } from "../../completion-review.ts";
import { requiredCompletionObligations } from "../../../output/completion/obligation-review.ts";
import {
  hasGoalCompletionReviewSkipTool,
} from "../policy/turn-evidence-gates.ts";
import { shouldRunGoalCompletionReview } from "../policy/turn-metadata-policy.ts";
import type { NativeStoredSessionConfig, NativeTurnRunnerDeps } from "./turn-runner-types.ts";
import type { PublicWorkDecision, ToolAuditEntry } from "../output/tool-types.ts";
import type { ToolSurfacePromptController } from "../../tool-surface-prompt-controller.ts";
import {
  applyPublicOutputGuards,
  repairFinalContract,
} from "./public-output-gates.ts";
import { emitTurnEventBestEffort } from "../progress/turn-delivery-events.ts";
import { persistTurnContextAtom } from "../../turn-continuation-context.ts";
import type { createDirectTurnBudget } from "../../direct-turn-budget.ts";
import { WorkStreamStore } from "../../../work/work-stream.ts";
import { TodoListStore } from "../../../work/todo-list.ts";
import type { CompletionTerminalState } from "../../completion-review.ts";

const EXPLICIT_TOOL_REPAIR_ATTEMPTS = 2;
const EXPLICIT_TOOL_REPAIR_BASE_ROUNDS = 2;
const EXPLICIT_TOOL_REPAIR_MAX_ROUNDS = 4;

export const KERNEL_COMPLETION_GAP_CONTINUATION_CODE = "completion_gap_continuation";

export type FinalDeliveryOutcome =
  | { kind: "final"; text: string; evidenceRefs: string[] }
  | {
      kind: "completion_gap";
      observation: {
        kind: string;
        summary: string;
        modelVisibleContent: string;
        refs?: Array<{ kind: string; id: string; path?: string }>;
      };
      evidenceRefs: string[];
    }
  | { kind: "waiting_user"; question: string; evidenceRefs: string[] }
  | { kind: "failed"; publicSummary: string; evidenceRefs: string[] };

export async function produceFinalDeliveryOutcome(input: {
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
  runToolPrompt(promptText: string, maxToolRounds?: number, phase?: string): Promise<string>;
}): Promise<FinalDeliveryOutcome> {
  const textAfterExplicitTools = await repairExplicitToolRequirements(input);
  const groundedText = applyGroundingIfNeeded(input, textAfterExplicitTools);
  const reviewResult = await runGoalCompletionReviews({ ...input, initialText: groundedText });
  if (reviewResult.outcome.status === "gap") {
    return {
      kind: "completion_gap",
      observation: reviewResult.outcome.observation,
      evidenceRefs: reviewResult.outcome.evidenceRefs,
    };
  }
  if (reviewResult.outcome.status === "waiting_user") {
    return {
      kind: "waiting_user",
      question: reviewResult.outcome.question,
      evidenceRefs: reviewResult.outcome.evidenceRefs,
    };
  }
  if (reviewResult.outcome.status === "failed") {
    return {
      kind: "failed",
      publicSummary: reviewResult.outcome.publicSummary,
      evidenceRefs: reviewResult.outcome.evidenceRefs,
    };
  }
  const contractRepairedText = repairFinalContract({ ...input, finalText: reviewResult.reviewedText });
  await emitTurnEventBestEffort(input.turnInput, {
    kind: "guard.started",
    payload: { guard: "public_output" },
  });
  const checkedText = applyPublicOutputGuards({ ...input, finalText: contractRepairedText });
  await emitTurnEventBestEffort(input.turnInput, {
    kind: "guard.completed",
    payload: { guard: "public_output", status: "approved" },
  });
  return { kind: "final", text: checkedText, evidenceRefs: reviewResult.outcome.evidenceRefs };
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

async function repairExplicitToolRequirements(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  useTools: boolean;
  prompt: string;
  initialText: string;
  audit: ToolAuditEntry[];
  toolSurfaceController: ToolSurfacePromptController;
  runToolPrompt(promptText: string, maxToolRounds?: number, phase?: string): Promise<string>;
}): Promise<string> {
  let text = input.initialText;
  if (!input.useTools) {
    return text;
  }
  const explicitTools = requiredExplicitToolNames(
    [input.session.init.metadata, input.turnInput.metadata],
    input.toolSurfaceController.initialToolNames(),
  );
  for (let repairAttempt = 0; repairAttempt < EXPLICIT_TOOL_REPAIR_ATTEMPTS; repairAttempt += 1) {
    const missingExplicitTools = explicitTools.filter((toolName) =>
      !hasSuccessfulTool(input.audit, [toolName]));
    if (missingExplicitTools.length === 0) {
      break;
    }
    const repairMaxToolRounds = Math.min(
      EXPLICIT_TOOL_REPAIR_MAX_ROUNDS,
      missingExplicitTools.length + EXPLICIT_TOOL_REPAIR_BASE_ROUNDS,
    );
    text = await input.runToolPrompt(explicitToolRequirementRepairPrompt({
      prompt: input.prompt,
      previousAnswer: text,
      missingTools: missingExplicitTools,
    }), repairMaxToolRounds, "explicit_tool_repair");
  }
  return text;
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
  runToolPrompt(promptText: string, maxToolRounds?: number, phase?: string): Promise<string>;
}): Promise<{ outcome: ReturnType<typeof evaluateCompletionReviewOutcome>; reviewedText: string }> {
  const shouldReview = shouldRunCompletionReview(input);
  if (!shouldReview) {
    return {
      outcome: {
        status: "complete",
        evidenceRefs: [],
      },
      reviewedText: input.initialText,
    };
  }
  const outcome = evaluateCompletionReviewOutcome({
    requestText: input.prompt,
    candidateText: input.initialText,
    evidenceReceipts: evidenceCapabilityReceiptsFromAudit(input.audit),
    requiredObligations: requiredCompletionObligations(input.publicDecisionContext),
    observations: observationsFromAudit(input.audit),
    workStreamTerminalState: currentWorkStreamsTerminalState({
      butlerData: input.deps.butlerData,
      sessionId: input.turnInput.handle.sessionId,
      turnId: input.turnId,
    }),
    todoTerminalState: currentTurnTodosTerminalState({
      butlerData: input.deps.butlerData,
      sessionId: input.turnInput.handle.sessionId,
      turnId: input.turnId,
    }),
  });
  return { outcome, reviewedText: input.initialText };
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
    .map((entry) => ({
      kind: "tool_result" as const,
      summary: entry.error ? `${entry.name}: ${entry.error}` : `${entry.name} failed.`,
      modelVisibleContent: entry.error ? `${entry.name}: ${entry.error}` : `${entry.name} failed.`,
      visibility: "model" as const,
    }));
}

function currentWorkStreamsTerminalState(input: {
  butlerData: string;
  sessionId: string;
  turnId?: string | null;
}): CompletionTerminalState {
  if (!input.turnId) return "none";
  const streams = new WorkStreamStore(input.butlerData).list({
    sessionId: input.sessionId,
    includeTerminal: true,
  });
  const store = new WorkStreamStore(input.butlerData);
  const turnLocalStreams = streams.filter((stream) => store.read(stream.id)?.last_user_turn_id === input.turnId);
  if (turnLocalStreams.length === 0) return "none";
  if (turnLocalStreams.some((stream) => stream.state === "failed")) return "failed";
  if (turnLocalStreams.some((stream) => stream.state === "waiting_user")) return "waiting_user";
  if (turnLocalStreams.some((stream) => stream.terminal !== true)) return "none";
  if (turnLocalStreams.some((stream) => stream.state === "cancelled")) return "cancelled";
  return "completed";
}

function currentTurnTodosTerminalState(input: {
  butlerData: string;
  sessionId: string;
  turnId?: string | null;
}): CompletionTerminalState {
  if (!input.turnId) return "none";
  const workStore = new WorkStreamStore(input.butlerData);
  const todoStore = new TodoListStore(input.butlerData);
  const todoListIds = workStore.list({
    sessionId: input.sessionId,
    includeTerminal: true,
  })
    .map((summary) => workStore.read(summary.id))
    .filter((record) => record?.last_user_turn_id === input.turnId)
    .map((record) => record?.todo_list_id)
    .filter((listId): listId is string => Boolean(listId));
  if (todoListIds.length === 0) return "none";
  let sawTerminal = false;
  for (const listId of [...new Set(todoListIds)]) {
    const todo = todoStore.read(listId);
    if (!todo) return "none";
    if (todo.items.some((item) => item.status === "in_progress" || item.status === "pending")) return "none";
    if (todo.items.some((item) => item.status === "completed" || item.status === "cancelled")) {
      sawTerminal = true;
    }
  }
  return sawTerminal ? "completed" : "none";
}

export async function persistCompletionGapContinuation(input: {
  turnInput: RuntimeTurnInput;
  deps: NativeTurnRunnerDeps;
  turnId?: string | null;
  audit: ToolAuditEntry[];
  publicDecisionContext: PublicWorkDecision[];
  observation: {
    kind: string;
    summary: string;
    modelVisibleContent: string;
    refs?: Array<{ kind: string; id: string; path?: string }>;
  };
}): Promise<void> {
  const turnId = input.turnId;
  if (!turnId) return;
  const refs = collectTurnContinuationRefs({
    butlerData: input.deps.butlerData,
    sessionId: input.turnInput.handle.sessionId,
    turnId,
    audit: input.audit,
    publicDecisionContext: input.publicDecisionContext,
  });
  persistTurnContextAtom({
    butlerData: input.deps.butlerData,
    sessionId: input.turnInput.handle.sessionId,
    turnId,
    state: "continuing",
    sourceErrorCode: KERNEL_COMPLETION_GAP_CONTINUATION_CODE,
    reason: input.observation.summary,
    userRequest: {
      id: currentUserMessageRef(input.turnInput),
    },
    ...refs,
    unresolvedObservations: [{
      kind: input.observation.kind,
      id: `completion-gap:${turnId}`,
    }, ...(input.observation.refs ?? [])],
    latestCompletionReview: {
      status: "gap",
      observationId: `completion-gap:${turnId}`,
    },
  });
  await emitTurnEventBestEffort(input.turnInput, {
    kind: "turn.observation",
    payload: {
      kind: input.observation.kind,
      safeLabel: input.observation.summary,
      modelVisibleContentChars: input.observation.modelVisibleContent.length,
    },
  });
  await emitTurnEventBestEffort(input.turnInput, {
    kind: "turn.continuation_scheduled",
    payload: {
      reason: KERNEL_COMPLETION_GAP_CONTINUATION_CODE,
      safeLabel: "Continuing from completion gap",
    },
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
  return {
    ...(latestAssistantDecision ? { latestAssistantDecision: { id: latestAssistantDecision } } : {}),
    openToolPairs,
    currentTurnWork,
    currentTurnTodos,
  };
}

function currentUserMessageRef(input: RuntimeTurnInput): string {
  if ("message" in input.input && typeof input.input.message?.id === "string") {
    return input.input.message.id;
  }
  return `turn:${input.handle.sessionId}`;
}
