import { readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DirectTurnBudgetSnapshot } from "./direct-turn-budget.ts";
import { isTerminalTurnState, type TurnState } from "./turn-kernel.ts";
import {
  withDurableFileLock,
  writeJsonFileAtomic,
} from "../persistence/atomic-json-store.ts";
import type { DurableTurnRoundJournalEntry } from "./turn-round-journal-contract.ts";
import type { TurnContractDecision } from "./turn-contract.ts";

export interface TurnContextObservationRef {
  kind: string;
  id: string;
  path?: string;
}

export interface TurnContextAtom {
  schemaVersion: "butler.turn-continuation.v2";
  generation: number;
  checkpointId: string;
  sessionId: string;
  turnId: string;
  state: TurnState;
  sourceErrorCode: string;
  reason: string;
  userRequest: { id: string };
  latestAssistantDecision?: { id: string };
  unresolvedObservations: TurnContextObservationRef[];
  openToolPairs: TurnContextObservationRef[];
  evidenceCandidates: TurnContextObservationRef[];
  latestCompletionReview?: { status: string; observationId?: string };
  currentTurnWork: TurnContextObservationRef[];
  currentTurnTodos: TurnContextObservationRef[];
  roundJournal?: DurableTurnRoundJournalEntry[];
  budgetSnapshot?: DirectTurnBudgetSnapshot;
  contractId?: string;
  turnDecision?: TurnContractDecision;
  workStreamId?: string;
  todoListId?: string;
  nextSemanticBlockSequence?: number;
  providerAdapterId?: string;
  effectiveModel?: string;
  terminalOutcome?: { id: string; state: string };
  createdAt: string;
  updatedAt: string;
}

export const TURN_SCHEDULER_CONTINUATION_YIELD_CODE = "turn_scheduler_continuation_yield";

export class TurnSchedulerContinuationYieldError extends Error {
  readonly code = TURN_SCHEDULER_CONTINUATION_YIELD_CODE;

  constructor(
    readonly sessionId: string,
    readonly turnId: string,
    readonly contextAtomId: string,
    readonly checkpointId?: string,
    readonly checkpointGeneration?: number,
  ) {
    super("Turn scheduler yielded after persisting a continuation context atom.");
    this.name = "TurnSchedulerContinuationYieldError";
  }
}

export function isTurnSchedulerContinuationYieldError(
  error: unknown,
): error is TurnSchedulerContinuationYieldError {
  return error instanceof TurnSchedulerContinuationYieldError ||
    (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === TURN_SCHEDULER_CONTINUATION_YIELD_CODE
    );
}

const TURN_KERNEL_CONTEXT_DIR_NAME = "turn-kernel";
const CONTINUATION_FILE_SUFFIX = "continuation.json";

export function createTurnContextAtomId(sessionId: string, turnId: string): string {
  const safeSession = safeIdSegment(sessionId);
  const safeTurn = safeIdSegment(turnId);
  return `${safeSession}-${safeTurn}-${CONTINUATION_FILE_SUFFIX}`;
}

export function persistTurnContextAtom(input: {
  butlerData: string;
  sessionId: string;
  turnId: string;
  state: TurnState;
  sourceErrorCode: string;
  reason: string;
  userRequest?: { id: string; text?: string };
  latestAssistantDecision?: { id: string };
  unresolvedObservations?: TurnContextObservationRef[];
  openToolPairs?: TurnContextObservationRef[];
  evidenceCandidates?: TurnContextObservationRef[];
  latestCompletionReview?: { status: string; observationId?: string };
  currentTurnWork?: TurnContextObservationRef[];
  currentTurnTodos?: TurnContextObservationRef[];
  roundJournal?: DurableTurnRoundJournalEntry[];
  budgetSnapshot?: DirectTurnBudgetSnapshot;
  terminalOutcome?: { id: string; state: string };
  contractId?: string;
  turnDecision?: TurnContractDecision;
  workStreamId?: string;
  todoListId?: string;
  nextSemanticBlockSequence?: number;
  providerAdapterId?: string;
  effectiveModel?: string;
  expectedGeneration?: number;
}): string | null {
  if (isTerminalTurnState(input.state)) return null;
  const contextAtomId = createTurnContextAtomId(input.sessionId, input.turnId);
  const path = continuationPathFor(input.butlerData, contextAtomId);
  const committed = withDurableFileLock({
    lockPath: `${path}.lock`,
    lockRoot: input.butlerData,
    ownerId: `turn-continuation:${contextAtomId}`,
    action: () => {
      const existing = readTurnContextAtom({
        butlerData: input.butlerData,
        sessionId: input.sessionId,
        turnId: input.turnId,
      });
      if (existing && input.expectedGeneration !== existing.generation) {
        throw new Error("turn_continuation_generation_conflict");
      }
      if (!existing && input.expectedGeneration !== undefined && input.expectedGeneration !== 0) {
        throw new Error("turn_continuation_generation_conflict");
      }
      const generation = (existing?.generation ?? 0) + 1;
      const now = new Date().toISOString();
      const value: TurnContextAtom = {
        schemaVersion: "butler.turn-continuation.v2",
        generation,
        checkpointId: `${contextAtomId}:g${generation}`,
        sessionId: input.sessionId,
        turnId: input.turnId,
        state: input.state,
        sourceErrorCode: input.sourceErrorCode,
        reason: input.reason,
        userRequest: { id: safeRefId(input.userRequest?.id ?? `turn:${input.turnId}`) },
        ...(input.latestAssistantDecision ? { latestAssistantDecision: input.latestAssistantDecision } : {}),
        unresolvedObservations: input.unresolvedObservations ?? [],
        openToolPairs: input.openToolPairs ?? [],
        evidenceCandidates: input.evidenceCandidates ?? [],
        ...(input.latestCompletionReview ? { latestCompletionReview: input.latestCompletionReview } : {}),
        currentTurnWork: input.currentTurnWork ?? [],
        currentTurnTodos: input.currentTurnTodos ?? [],
        ...(input.roundJournal || existing?.roundJournal
          ? { roundJournal: mergeRoundJournal(existing?.roundJournal, input.roundJournal) }
          : {}),
        ...(input.budgetSnapshot ? { budgetSnapshot: sanitizeBudgetSnapshot(input.budgetSnapshot) } : {}),
        ...(input.contractId ? { contractId: safeRefId(input.contractId) } : {}),
        ...(input.turnDecision ? { turnDecision: sanitizeTurnDecision(input.turnDecision) } : {}),
        ...(input.workStreamId ? { workStreamId: safeRefId(input.workStreamId) } : {}),
        ...(input.todoListId ? { todoListId: safeRefId(input.todoListId) } : {}),
        ...(input.nextSemanticBlockSequence !== undefined
          ? { nextSemanticBlockSequence: finiteNonNegativeInteger(input.nextSemanticBlockSequence) }
          : {}),
        ...(input.providerAdapterId ? { providerAdapterId: safeRefId(input.providerAdapterId) } : {}),
        ...(input.effectiveModel ? { effectiveModel: safeRefId(input.effectiveModel) } : {}),
        ...(input.terminalOutcome ? { terminalOutcome: input.terminalOutcome } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      writeJsonFileAtomic(path, value);
      return value;
    },
  });
  if (!committed) throw new Error("turn_continuation_commit_conflict");
  return contextAtomId;
}

export function readTurnContextAtom(input: {
  butlerData: string;
  sessionId: string;
  turnId: string;
}): TurnContextAtom | null {
  const path = continuationPathFor(input.butlerData, createTurnContextAtomId(input.sessionId, input.turnId));
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text) as TurnContextAtom;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      ...parsed,
      schemaVersion: "butler.turn-continuation.v2",
      generation: finitePositiveInteger(parsed.generation),
      checkpointId: parsed.checkpointId || `${createTurnContextAtomId(input.sessionId, input.turnId)}:g1`,
      evidenceCandidates: Array.isArray(parsed.evidenceCandidates)
        ? parsed.evidenceCandidates
        : [],
      roundJournal: Array.isArray(parsed.roundJournal) ? parsed.roundJournal : [],
      updatedAt: parsed.updatedAt ?? parsed.createdAt,
    };
  } catch {
    return null;
  }
}

export function clearTurnContextAtom(input: {
  butlerData: string;
  sessionId: string;
  turnId: string;
}): void {
  const path = continuationPathFor(input.butlerData, createTurnContextAtomId(input.sessionId, input.turnId));
  if (!existsSync(path)) return;
  rmSync(path, { force: true });
}

function continuationPathFor(butlerData: string, fileName: string): string {
  return join(butlerData, "state", TURN_KERNEL_CONTEXT_DIR_NAME, fileName);
}

function safeIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/gu, "_").slice(0, 96) || "unknown";
}

function safeRefId(value: string): string {
  return value.replace(/[^\S\n]+/gu, " ").replace(/[\r\n]+/gu, " ").trim().slice(0, 160) || "unknown";
}

function sanitizeBudgetSnapshot(snapshot: DirectTurnBudgetSnapshot): DirectTurnBudgetSnapshot {
  return {
    turnId: safeRefId(snapshot.turnId),
    modelRequestsUsed: finiteNonNegativeInteger(snapshot.modelRequestsUsed),
    promptTokens: finiteNonNegativeInteger(snapshot.promptTokens),
    cachedTokens: finiteNonNegativeInteger(snapshot.cachedTokens),
    outputTokens: finiteNonNegativeInteger(snapshot.outputTokens),
    totalTokens: finiteNonNegativeInteger(snapshot.totalTokens),
    maxModelCalls: finitePositiveInteger(snapshot.maxModelCalls),
    maxPromptTokens: finitePositiveInteger(snapshot.maxPromptTokens),
    maxOutputTokens: finitePositiveInteger(snapshot.maxOutputTokens),
    maxTotalTokens: finitePositiveInteger(snapshot.maxTotalTokens),
  };
}

function sanitizeTurnDecision(decision: TurnContractDecision): TurnContractDecision {
  return {
    schema_version: decision.schema_version,
    decision_id: safeRefId(decision.decision_id),
    action: decision.action,
    ...(decision.target_workstream_id
      ? { target_workstream_id: safeRefId(decision.target_workstream_id) }
      : {}),
    ...(decision.target_project_id ? { target_project_id: safeRefId(decision.target_project_id) } : {}),
    ...(decision.blocker_id ? { blocker_id: safeRefId(decision.blocker_id) } : {}),
    deliverables: [...decision.deliverables],
    ...(decision.answer_text ? { answer_text: safeDecisionText(decision.answer_text) } : {}),
    ...(decision.public_title ? { public_title: safeDecisionText(decision.public_title) } : {}),
    public_summary: safeDecisionText(decision.public_summary),
    ...(decision.public_rationale
      ? { public_rationale: safeDecisionText(decision.public_rationale) }
      : {}),
    ...(decision.immediate_next_step
      ? { immediate_next_step: safeDecisionText(decision.immediate_next_step) }
      : {}),
  };
}

function mergeRoundJournal(
  previous: DurableTurnRoundJournalEntry[] | undefined,
  current: DurableTurnRoundJournalEntry[] | undefined,
): DurableTurnRoundJournalEntry[] {
  const entries = [...(previous ?? []), ...(current ?? [])];
  return entries.map((entry, index) => ({
    ...entry,
    sequence: index + 1,
  }));
}

function safeDecisionText(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 420);
}

function finiteNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function finitePositiveInteger(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 1;
}
