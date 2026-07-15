import { createHash } from "node:crypto";
import { AgentConversationStore } from "../../../../agent/conversation/store.ts";
import {
  btccAttemptIdForTurn,
  conversationSessionIdForDurableSession,
} from "../../../../agent/conversation/session-admission.ts";
import { BtccRecoveryCaseStore } from "../../../../agent/turn/interruption/recovery-case-store.ts";
import {
  routeTurnInterruption,
  runtimeInterruptionFromUnknown,
} from "../../../../agent/turn/interruption/turn-interruption-router.ts";
import {
  TURN_INTERRUPTION_ENVELOPE_SCHEMA,
  type BtccTurnStateRecord,
} from "../../../../agent/turn/interruption/turn-interruption-types.ts";
import type {
  TurnInterruptionOrigin,
} from "../../../../agent/turn/interruption/turn-interruption-producer-registry.ts";
import { sessionHintForRow } from "./session-read-model.ts";

export interface AppResponderInterruptionInput {
  butlerData: string;
  chatId: string;
  turnId: string;
  messageId: string;
  text: string;
  actor: "user" | "system";
  projectId?: string | null;
  origin: Extract<TurnInterruptionOrigin, "legacy_responder" | "projection">;
  boundary: string;
  error: unknown;
  now?: string;
}

export interface AppResponderInterruptionResult {
  state: BtccTurnStateRecord;
  recoveryCaseId: string | null;
}

export function routeAppResponderRuntimeInterruption(
  input: AppResponderInterruptionInput,
): AppResponderInterruptionResult {
  let conversations: AgentConversationStore | null = null;
  let recoveryCases: BtccRecoveryCaseStore | null = null;
  try {
    conversations = new AgentConversationStore({
      butlerData: input.butlerData,
    });
    recoveryCases = new BtccRecoveryCaseStore({
      butlerData: input.butlerData,
    });
    let state = recoveryCases.readTurnState(input.turnId);
    if (!state) {
      const existingTurn = conversations.readTurn(input.turnId);
      const durableSessionId = sessionHintForRow(input.chatId);
      const turn = existingTurn ?? conversations.beginTurn({
        gateway: "app",
        externalSessionId: durableSessionId,
        sessionId: conversationSessionIdForDurableSession(durableSessionId),
        workspaceId: null,
        projectId: input.projectId ?? null,
        actor: input.actor,
        requestId: `app-responder:${input.messageId}`,
        turnId: input.turnId,
        now: input.now,
      });
      if (!existingTurn && input.actor === "user") {
        conversations.appendUserMessage({
          sessionId: turn.session_id,
          turnId: turn.id,
          text: input.text,
          sourceGateway: "app",
          sourceRef: input.messageId,
          now: input.now,
        });
      }
      state = recoveryCases.admitTurn({
        turnId: turn.id,
        sessionId: turn.session_id,
        attemptId: btccAttemptIdForTurn(turn.id),
        now: input.now,
      });
    }
    if (state.state === "waiting_runtime") {
      return {
        state,
        recoveryCaseId: state.activeRecoveryCaseId ?? null,
      };
    }
    if (state.state === "delivered" || state.state === "cancelled") {
      return { state, recoveryCaseId: null };
    }
    const checkpointRef = state.lastStableCheckpointRef ??
      `btcc-turn-state:${state.turnId}:g${state.generation}`;
    const interruptionId = `interruption-${stableId({
      turnId: state.turnId,
      attemptId: state.attemptId,
      generation: state.generation,
      origin: input.origin,
      boundary: input.boundary,
    })}`;
    const directive = routeTurnInterruption(runtimeInterruptionFromUnknown({
      error: input.error,
      interruptionId,
      turnId: state.turnId,
      attemptId: state.attemptId,
      origin: input.origin,
      currentGeneration: state.generation,
      lastStableCheckpointRef: checkpointRef,
      createdAt: input.now ?? new Date().toISOString(),
      sideEffectState: "indeterminate",
      resumePredicateRef:
        `app-responder-runtime-revision:${state.turnId}:g${state.generation}`,
      diagnosticRefs: [],
    }));
    if (directive.kind !== "waiting_runtime") {
      throw new Error("app_responder_interruption_route_invalid");
    }
    const waiting = recoveryCases.applyDirective(directive);
    return {
      state: waiting,
      recoveryCaseId: directive.recoveryCase.recoveryCaseId,
    };
  } finally {
    recoveryCases?.close();
    conversations?.close();
  }
}

export function appResponderRuntimeRecoveryOwnsTurn(
  butlerData: string,
  turnId: string,
): boolean {
  let recoveryCases: BtccRecoveryCaseStore | null = null;
  try {
    recoveryCases = new BtccRecoveryCaseStore({ butlerData });
    const state = recoveryCases.readTurnState(turnId);
    return state?.state === "waiting_runtime" &&
      Boolean(state.activeRecoveryCaseId);
  } catch {
    // Storage uncertainty must not create a second continuation owner. Keeping
    // the App turn parked is safe; the scheduler can resume only after the
    // durable BTCC owner is readable again.
    return true;
  } finally {
    recoveryCases?.close();
  }
}

export function cancelAppResponderRuntimeTurn(
  butlerData: string,
  turnId: string,
  now = new Date().toISOString(),
): BtccTurnStateRecord | null {
  let recoveryCases: BtccRecoveryCaseStore | null = null;
  try {
    recoveryCases = new BtccRecoveryCaseStore({ butlerData });
    const current = recoveryCases.readTurnState(turnId);
    if (!current || current.state === "cancelled" || current.state === "delivered") {
      return current;
    }
    const cancellationReceiptRef =
      `app-turn-cancellation:${turnId}:g${current.generation}`;
    return recoveryCases.applyDirective(routeTurnInterruption({
      schemaVersion: TURN_INTERRUPTION_ENVELOPE_SCHEMA,
      kind: "user_cancellation",
      interruptionId: cancellationReceiptRef,
      turnId: current.turnId,
      attemptId: current.attemptId,
      origin: "admission",
      currentGeneration: current.generation,
      lastStableCheckpointRef: current.lastStableCheckpointRef ??
        `btcc-turn-state:${current.turnId}:g${current.generation}`,
      createdAt: now,
      cancellationGeneration: current.generation,
      cancellationReceiptRef,
    }));
  } catch {
    return null;
  } finally {
    recoveryCases?.close();
  }
}

function stableId(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 24);
}
