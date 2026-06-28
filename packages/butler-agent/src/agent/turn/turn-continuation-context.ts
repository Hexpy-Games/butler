import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isTerminalTurnState, type TurnState } from "./turn-kernel.ts";

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
  latestCompletionReview?: { status: string; observationId?: string };
  currentTurnWork: TurnContextObservationRef[];
  currentTurnTodos: TurnContextObservationRef[];
  terminalOutcome?: { id: string; state: string };
  createdAt: string;
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
  latestCompletionReview?: { status: string; observationId?: string };
  currentTurnWork?: TurnContextObservationRef[];
  currentTurnTodos?: TurnContextObservationRef[];
  terminalOutcome?: { id: string; state: string };
}): void {
  if (isTerminalTurnState(input.state)) return;
  const path = continuationPathFor(input.butlerData, createTurnContextAtomId(input.sessionId, input.turnId));
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
    ...(input.latestCompletionReview ? { latestCompletionReview: input.latestCompletionReview } : {}),
    currentTurnWork: input.currentTurnWork ?? [],
    currentTurnTodos: input.currentTurnTodos ?? [],
    ...(input.terminalOutcome ? { terminalOutcome: input.terminalOutcome } : {}),
    createdAt: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
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
    return parsed;
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
