import type { BtccTurnProgressObserver } from "../contracts.ts";
import type { GuidedEffectAccessMode } from "../effects/index.ts";
import {
  AUTHORITY_DENIAL_TEXT,
  type AuthorityOutcomeReceipt,
  type PrincipalAuthority,
} from "../authority/index.ts";
import type {
  GuidedActivityBinding,
  GuidedActivityProjection,
} from "../projection/index.ts";
import type { BtccAgentLoopInput } from "./contracts.ts";

/**
 * Captures only user-facing progress text for operational fallback.  The
 * wrapped observer remains downstream-only; its facts never enter Work or
 * effect authorization.
 */
export function createGuidedOperationalProgressCapture(
  progress: BtccTurnProgressObserver | undefined,
): {
  observer: BtccTurnProgressObserver | undefined;
  facts(): string[];
} {
  if (!progress) return { observer: undefined, facts: () => [] };
  const values: string[] = [];
  const remember = (value: string | undefined): void => {
    const text = value?.trim();
    if (text && !values.includes(text)) values.push(text);
  };
  return {
    observer: {
      stateChanged: (update) => progress.stateChanged(update),
      workProgressChanged: (update) => {
        if (isCurrentMaterialUpdate(update)) {
          for (const task of update.tasks) remember(task.taskOutcome || task.taskTitle);
        }
        return progress.workProgressChanged?.(update);
      },
      phaseActivityChanged: (update) => {
        if (isCurrentMaterialUpdate(update)) {
          remember(update.summary);
          remember(update.nextStep);
        }
        return progress.phaseActivityChanged?.(update);
      },
      operationChanged: (update) => progress.operationChanged?.(update),
      modelRoundWaitingChanged: (update) => progress.modelRoundWaitingChanged?.(update),
      operationalNoticeChanged: (update) => progress.operationalNoticeChanged?.(update),
      runtimeFaulted: (update) => progress.runtimeFaulted?.(update),
    },
    facts: () => values.slice(),
  };
}

function isCurrentMaterialUpdate(update: {
  turnId: string;
  originTurnId?: string;
  sourceRevision?: number;
}): boolean {
  return update.originTurnId === update.turnId &&
    typeof update.sourceRevision === "number" &&
    Number.isInteger(update.sourceRevision) && update.sourceRevision > 0;
}

export function createGuidedAskFirstProgress(
  progress: BtccTurnProgressObserver | undefined,
): BtccTurnProgressObserver | undefined {
  if (!progress) return undefined;
  return { stateChanged: (update) => progress.stateChanged(update) };
}

export function createGuidedAuthorityProjection(input: {
  accessMode: GuidedEffectAccessMode;
  activity: GuidedActivityProjection;
  authority?: PrincipalAuthority;
  ownerSessionId: string;
  turnId: string;
  requestRef?: string;
}): {
  publicActivity: GuidedActivityProjection;
  loopCallbacks: Pick<
    BtccAgentLoopInput,
    "onAssistantTextBeforeTools" | "finalTextFromToolResult"
  >;
  continuation: boolean;
  project(text: string): string;
} {
  const authorityDecision = authorityDecisionForContinuation(input);
  const publicActivity = createGuidedPublicActivity({
    accessMode: input.accessMode,
    activity: input.activity,
    ...(authorityDecision ? { authorityDecision } : {}),
  });
  return {
    publicActivity,
    loopCallbacks: createGuidedPublicLoopCallbacks({
      accessMode: input.accessMode,
      activity: publicActivity,
      ...(authorityDecision ? { authorityDecision } : {}),
    }),
    continuation: Boolean(input.requestRef),
    project: (text) => input.requestRef
      ? projectGuidedAuthorityOutcome({
          authority: input.authority,
          ownerSessionId: input.ownerSessionId,
          turnId: input.turnId,
          requestRef: input.requestRef,
        })
      : text,
  };
}

function authorityDecisionForContinuation(input: {
  authority?: PrincipalAuthority;
  ownerSessionId: string;
  turnId: string;
  requestRef?: string;
}): "allowed" | "denied" | "modified" | undefined {
  if (!input.authority || !input.requestRef) return undefined;
  try {
    return input.authority.execution({
      ownerSessionId: input.ownerSessionId,
      requestRef: input.requestRef,
      turnId: input.turnId,
    }).decision;
  } catch {
    return undefined;
  }
}

function createGuidedPublicActivity(input: {
  accessMode: GuidedEffectAccessMode;
  activity: GuidedActivityProjection;
  authorityDecision?: "allowed" | "denied" | "modified";
}): GuidedActivityProjection {
  if (input.accessMode !== "ask_first") return input.activity;
  const pendingText = input.authorityDecision === "denied"
    ? AUTHORITY_DENIAL_TEXT
    : input.authorityDecision === "modified"
      ? "Replacement command is waiting for Allow."
    : "Reviewed command pending Allow.";
  return {
    observeToolBatch: (batch) => input.activity.observeToolBatch({
      text: pendingText,
      toolCalls: batch.toolCalls.map((call) => ({ name: call.name, args: {} })),
    }),
    observeTool: (call) => input.activity.observeTool({ ...call, args: {} }),
    markManaged: (binding?: GuidedActivityBinding) => input.activity.markManaged(binding),
    publishAccepted: (binding: GuidedActivityBinding) => input.activity.publishAccepted(binding),
  };
}

function createGuidedPublicLoopCallbacks(input: {
  accessMode: GuidedEffectAccessMode;
  activity: GuidedActivityProjection;
  authorityDecision?: "allowed" | "denied" | "modified";
}): Pick<BtccAgentLoopInput, "onAssistantTextBeforeTools" | "finalTextFromToolResult"> {
  return {
    onAssistantTextBeforeTools: ({ text, toolCalls }) => input.activity.observeToolBatch({
      text: input.accessMode !== "ask_first"
        ? text
        : input.authorityDecision === "denied"
          ? AUTHORITY_DENIAL_TEXT
          : input.authorityDecision === "modified"
            ? "Replacement command is waiting for Allow."
          : "Reviewed command pending Allow.",
      toolCalls: toolCalls.map((call) => ({
        name: call.name,
        args: input.accessMode === "ask_first" ? {} : call.arguments,
      })),
    }),
    finalTextFromToolResult: ({ toolResult }) => {
      if (input.authorityDecision === "denied") return AUTHORITY_DENIAL_TEXT;
      if (input.authorityDecision === "modified" && authorityPending(toolResult.output)) {
        return "Replacement command is waiting for Allow.";
      }
      return authorityPending(toolResult.output)
        ? "This reviewed command is waiting for Allow."
        : null;
    },
  };
}

function projectGuidedAuthorityOutcome(input: {
  authority?: PrincipalAuthority;
  ownerSessionId: string;
  turnId: string;
  requestRef: string;
}): string {
  if (!input.authority) return "Approved command outcome could not be verified.";
  try {
    const execution = input.authority.execution({
      ownerSessionId: input.ownerSessionId,
      requestRef: input.requestRef,
      turnId: input.turnId,
    });
    if (execution.decision === "denied") return AUTHORITY_DENIAL_TEXT;
    if (execution.decision === "modified") return "Replacement command is waiting for Allow.";
    if (execution.outcome === "applied") return "Approved command completed once.";
    if (execution.outcome === "failed") return "Approved command failed to complete.";
    if (execution.outcome === "uncertain") {
      return authorityUncertainOutcomeText(execution.outcomeReceipt);
    }
    return "Approved command outcome is pending.";
  } catch {
    return "Approved command outcome could not be verified.";
  }
}

function authorityPending(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).authority_pending === true;
}

const AUTHORITY_UNCERTAIN_TEXT = "확인 필요";
const AUTHORITY_EVIDENCE_REF_PREFIX = "authority-evidence-";
const AUTHORITY_EVIDENCE_REF_BODY_MIN = 8;
const AUTHORITY_EVIDENCE_REF_BODY_MAX = 64;
const AUTHORITY_EVIDENCE_REF_BODY_PATTERN = /^[a-z0-9-]+$/;

/**
 * Terminal projection for a possibly-started uncertain authority outcome.
 * Emits only a bounded, opaque evidence reference when it matches the safe
 * format; receipt internals (journal ids, attempt counts, error codes) and any
 * malformed or unbounded evidence value never reach the public string.
 */
function authorityUncertainOutcomeText(
  receipt: AuthorityOutcomeReceipt | undefined,
): string {
  const evidenceRef = safeAuthorityEvidenceRef(receipt?.evidenceRef);
  return evidenceRef
    ? `${AUTHORITY_UNCERTAIN_TEXT} · ${evidenceRef}`
    : AUTHORITY_UNCERTAIN_TEXT;
}

function safeAuthorityEvidenceRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith(AUTHORITY_EVIDENCE_REF_PREFIX)) return null;
  const body = value.slice(AUTHORITY_EVIDENCE_REF_PREFIX.length);
  if (body.length < AUTHORITY_EVIDENCE_REF_BODY_MIN) return null;
  if (body.length > AUTHORITY_EVIDENCE_REF_BODY_MAX) return null;
  if (!AUTHORITY_EVIDENCE_REF_BODY_PATTERN.test(body)) return null;
  return value;
}
