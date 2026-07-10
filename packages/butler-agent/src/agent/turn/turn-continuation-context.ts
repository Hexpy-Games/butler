import { readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DirectTurnBudgetSnapshot } from "./direct-turn-budget.ts";
import { isTerminalTurnState, type TurnState } from "./turn-kernel.ts";
import { writeJsonFileAtomic } from "../persistence/atomic-json-store.ts";
import type { DurableTurnRoundJournalEntry } from "./native/turn-runner/turn-round-journal.ts";

export interface TurnContextObservationRef {
  kind: string;
  id: string;
  path?: string;
}

export interface TurnContextAtom {
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
  terminalOutcome?: { id: string; state: string };
  createdAt: string;
}

export const TURN_SCHEDULER_CONTINUATION_YIELD_CODE = "turn_scheduler_continuation_yield";

export class TurnSchedulerContinuationYieldError extends Error {
  readonly code = TURN_SCHEDULER_CONTINUATION_YIELD_CODE;

  constructor(
    readonly sessionId: string,
    readonly turnId: string,
    readonly contextAtomId: string,
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
}): string | null {
  if (isTerminalTurnState(input.state)) return null;
  const contextAtomId = createTurnContextAtomId(input.sessionId, input.turnId);
  const path = continuationPathFor(input.butlerData, contextAtomId);
  const value: TurnContextAtom = {
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
    ...(input.roundJournal ? { roundJournal: input.roundJournal.slice(-18) } : {}),
    ...(input.budgetSnapshot ? { budgetSnapshot: sanitizeBudgetSnapshot(input.budgetSnapshot) } : {}),
    ...(input.terminalOutcome ? { terminalOutcome: input.terminalOutcome } : {}),
    createdAt: new Date().toISOString(),
  };
  writeJsonFileAtomic(path, value);
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
      evidenceCandidates: Array.isArray(parsed.evidenceCandidates)
        ? parsed.evidenceCandidates
        : [],
      roundJournal: Array.isArray(parsed.roundJournal) ? parsed.roundJournal.slice(-18) : [],
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

function finiteNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function finitePositiveInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}
