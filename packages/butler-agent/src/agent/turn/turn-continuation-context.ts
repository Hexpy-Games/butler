import { readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  DIRECT_TURN_LIFETIME_MODEL_CALL_LIMIT,
  type DirectTurnBudgetSnapshot,
} from "./direct-turn-budget.ts";
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

export interface TurnObligationFrontierCheckpoint {
  planReady?: boolean;
  gated: boolean;
  ledgerDiscoveryObserved?: boolean;
  ledgerDiscoveryCandidateCount?: number;
  requiredLedgerKinds: Array<"spec" | "work" | "task">;
  observedLedgerKinds: Array<"spec" | "work" | "task">;
  ledgerCheckPassed: boolean;
  workspaceMutationObserved: boolean;
  workspaceInspectionCount?: number;
  workspaceActionFocused?: boolean;
  workspaceActionRejections?: number;
  validationObserved: boolean;
  validationFailed: boolean;
  validationFocused?: boolean;
  statusObserved?: boolean;
  statusFocused?: boolean;
  stage: "open" | "work_planning" | "ledger" | "workspace_execution" | "workspace_action" | "workspace_validation" | "workspace_repair" | "status_inspection" | "closeout";
}

export interface TurnContextAtom {
  schemaVersion: "butler.turn-continuation.v2";
  generation: number;
  checkpointId: string;
  sessionId: string;
  turnId: string;
  state: TurnState;
  sourceErrorCode: string;
  retryableProviderFailureStreak?: number;
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
  obligationFrontier?: TurnObligationFrontierCheckpoint;
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
    readonly sourceErrorCode?: string,
    readonly retryableProviderFailureStreak?: number,
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
  obligationFrontier?: TurnObligationFrontierCheckpoint;
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
      const retryableProviderFailureStreak = providerFailureStreak({
        existing,
        sourceErrorCode: input.sourceErrorCode,
        roundJournal: input.roundJournal,
      });
      const value: TurnContextAtom = {
        schemaVersion: "butler.turn-continuation.v2",
        generation,
        checkpointId: `${contextAtomId}:g${generation}`,
        sessionId: input.sessionId,
        turnId: input.turnId,
        state: input.state,
        sourceErrorCode: input.sourceErrorCode,
        ...(retryableProviderFailureStreak > 0 ? { retryableProviderFailureStreak } : {}),
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
        ...(input.obligationFrontier
          ? { obligationFrontier: sanitizeObligationFrontier(input.obligationFrontier) }
          : {}),
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

function providerFailureStreak(input: {
  existing: TurnContextAtom | null;
  sourceErrorCode: string;
  roundJournal?: DurableTurnRoundJournalEntry[];
}): number {
  if (!input.sourceErrorCode.startsWith("provider_")) return 0;
  const existingJournalEntries = new Set(
    (input.existing?.roundJournal ?? []).map(roundJournalEntryIdentity),
  );
  const newRoundObserved = (input.roundJournal ?? [])
    .some((entry) => !existingJournalEntries.has(roundJournalEntryIdentity(entry)));
  const sameFailureWithoutNewRound = input.existing?.sourceErrorCode === input.sourceErrorCode &&
    !newRoundObserved;
  return sameFailureWithoutNewRound
    ? Math.max(1, input.existing?.retryableProviderFailureStreak ?? 1) + 1
    : 1;
}

function roundJournalEntryIdentity(entry: DurableTurnRoundJournalEntry): string {
  return [
    entry.decision_id,
    entry.semantic_block_id,
    entry.tool,
    entry.call_identity,
    entry.result_fingerprint,
    entry.state_revision,
  ].join(":");
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
      retryableProviderFailureStreak: finiteNonNegativeInteger(
        parsed.retryableProviderFailureStreak ?? 0,
      ),
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

export function turnContextAtomsForTurn(input: {
  butlerData: string;
  turnId: string;
}): TurnContextAtom[] {
  const dir = join(input.butlerData, "state", TURN_KERNEL_CONTEXT_DIR_NAME);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(CONTINUATION_FILE_SUFFIX))
    .flatMap((name) => {
      try {
        const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as TurnContextAtom;
        return parsed?.turnId === input.turnId ? [parsed] : [];
      } catch {
        return [];
      }
    });
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

function sanitizeObligationFrontier(
  frontier: TurnObligationFrontierCheckpoint,
): TurnObligationFrontierCheckpoint {
  const ledgerKinds = new Set(["spec", "work", "task"] as const);
  const stages = new Set<TurnObligationFrontierCheckpoint["stage"]>([
    "open", "work_planning", "ledger", "workspace_execution", "workspace_action", "workspace_validation", "workspace_repair", "status_inspection", "closeout",
  ]);
  const kinds = (values: readonly string[]) => [...new Set(values)]
    .filter((value): value is "spec" | "work" | "task" =>
      ledgerKinds.has(value as "spec" | "work" | "task"))
    .sort();
  return {
    planReady: frontier.planReady === true,
    gated: frontier.gated === true,
    ledgerDiscoveryObserved: frontier.ledgerDiscoveryObserved === true,
    ledgerDiscoveryCandidateCount: finiteNonNegativeInteger(
      frontier.ledgerDiscoveryCandidateCount ?? 0,
    ),
    requiredLedgerKinds: kinds(frontier.requiredLedgerKinds),
    observedLedgerKinds: kinds(frontier.observedLedgerKinds),
    ledgerCheckPassed: frontier.ledgerCheckPassed === true,
    workspaceMutationObserved: frontier.workspaceMutationObserved === true,
    workspaceInspectionCount: finiteNonNegativeInteger(frontier.workspaceInspectionCount ?? 0),
    workspaceActionFocused: frontier.workspaceActionFocused === true,
    workspaceActionRejections: finiteNonNegativeInteger(frontier.workspaceActionRejections ?? 0),
    validationObserved: frontier.validationObserved === true,
    validationFailed: frontier.validationFailed === true,
    validationFocused: frontier.validationFocused === true,
    statusObserved: frontier.statusObserved === true,
    statusFocused: frontier.statusFocused === true,
    stage: stages.has(frontier.stage) ? frontier.stage : "open",
  };
}

function sanitizeBudgetSnapshot(snapshot: DirectTurnBudgetSnapshot): DirectTurnBudgetSnapshot {
  const cumulativePromptTokens = finiteNonNegativeInteger(
    snapshot.cumulativeUsage?.promptTokens ?? snapshot.promptTokens,
  );
  return {
    turnId: safeRefId(snapshot.turnId),
    executionSlice: finitePositiveInteger(snapshot.executionSlice ?? 1),
    modelRequestsUsed: finiteNonNegativeInteger(snapshot.modelRequestsUsed),
    promptTokens: finiteNonNegativeInteger(snapshot.promptTokens),
    cachedTokens: finiteNonNegativeInteger(snapshot.cachedTokens),
    outputTokens: finiteNonNegativeInteger(snapshot.outputTokens),
    totalTokens: finiteNonNegativeInteger(snapshot.totalTokens),
    maxModelCalls: finitePositiveInteger(snapshot.maxModelCalls),
    maxLifetimeModelCalls: finitePositiveInteger(
      snapshot.maxLifetimeModelCalls ?? DIRECT_TURN_LIFETIME_MODEL_CALL_LIMIT,
    ),
    maxPromptTokens: finitePositiveInteger(snapshot.maxPromptTokens),
    maxOutputTokens: finitePositiveInteger(snapshot.maxOutputTokens),
    maxTotalTokens: finitePositiveInteger(snapshot.maxTotalTokens),
    cumulativeUsage: {
      modelRequestsUsed: finiteNonNegativeInteger(
        snapshot.cumulativeUsage?.modelRequestsUsed ?? snapshot.modelRequestsUsed,
      ),
      promptTokens: cumulativePromptTokens,
      cachedTokens: Math.min(
        cumulativePromptTokens,
        finiteNonNegativeInteger(
          snapshot.cumulativeUsage?.cachedTokens ?? snapshot.cachedTokens,
        ),
      ),
      outputTokens: finiteNonNegativeInteger(
        snapshot.cumulativeUsage?.outputTokens ?? snapshot.outputTokens,
      ),
      totalTokens: finiteNonNegativeInteger(
        snapshot.cumulativeUsage?.totalTokens ?? snapshot.totalTokens,
      ),
    },
    ...(snapshot.partitions
      ? {
          partitions: Object.fromEntries(
            (["execution", "review", "finalization"] as const).map((name) => {
              const partition = snapshot.partitions![name];
              return [name, {
                modelRequestsUsed: finiteNonNegativeInteger(partition.modelRequestsUsed),
                promptTokens: finiteNonNegativeInteger(partition.promptTokens),
                cachedTokens: Math.min(
                  finiteNonNegativeInteger(partition.cachedTokens),
                  finiteNonNegativeInteger(partition.promptTokens),
                ),
                outputTokens: finiteNonNegativeInteger(partition.outputTokens),
                totalTokens: finiteNonNegativeInteger(partition.totalTokens),
                maxModelCalls: finitePositiveInteger(partition.maxModelCalls),
                maxPromptTokens: finitePositiveInteger(partition.maxPromptTokens),
                maxOutputTokens: finitePositiveInteger(partition.maxOutputTokens),
                maxTotalTokens: finitePositiveInteger(partition.maxTotalTokens),
              }];
            }),
          ) as NonNullable<DirectTurnBudgetSnapshot["partitions"]>,
        }
      : {}),
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
