import type { BtccTurnCommand } from "../contracts.ts";
import { admitTurn } from "./admission/index.ts";
import type { TurnRecord } from "./contracts.ts";
import type {
  TurnAdmissionRepository,
  TurnStateRepository,
} from "./contracts.ts";

export type ContinuingTurnCommand = Exclude<BtccTurnCommand, { kind: "stop" }>;

export async function loadOrAdmitTurn(
  command: ContinuingTurnCommand,
  dependencies: {
    admission: TurnAdmissionRepository;
    turns: TurnStateRepository;
  },
  onAdmitted?: (turn: TurnRecord, isFresh: boolean) => void | Promise<void>,
): Promise<TurnRecord> {
  const existing = await dependencies.turns.findTurn(command.turnId);
  if (existing) {
    if (command.kind !== "resume") {
      assertStableRequestIdentity(existing, requestIdentityForCommand(command));
    }
    await onAdmitted?.(existing, false);
    return existing;
  }
  if (command.kind === "resume") {
    throw new Error(`BTCC Turn is not admitted: ${command.turnId}`);
  }
  const admitted = await admitTurn(command, dependencies.admission, dependencies.turns);
  await onAdmitted?.(admitted, true);
  return admitted;
}

export type StableTurnRequestIdentity = {
  sessionId: string;
  triggerKey: string;
  messageId: string;
  content: string;
  wake?: {
    triggerId: string;
    sourceTurnId: string;
    authorizationRef: string;
    resultScopeRef?: string;
  };
};

export function requestIdentityForCommand(
  command: Extract<BtccTurnCommand, { kind: "run" | "wake" }>,
): StableTurnRequestIdentity {
  if (command.kind === "run") {
    return {
      sessionId: command.sessionId,
      triggerKey: command.triggerKey,
      messageId: command.message.messageId,
      content: command.message.content,
    };
  }
  return {
    sessionId: command.sessionId,
    triggerKey: command.triggerKey,
    messageId: command.trigger.triggerId,
    content: command.trigger.content,
    wake: {
      triggerId: command.trigger.triggerId,
      sourceTurnId: command.trigger.sourceTurnId,
      authorizationRef: command.trigger.authorizationRef,
      ...(command.trigger.resultScopeRef
        ? { resultScopeRef: command.trigger.resultScopeRef }
        : {}),
    },
  };
}

export function assertStableRequestIdentity(
  turn: TurnRecord,
  identity: StableTurnRequestIdentity,
): void {
  if (
    turn.sessionId !== identity.sessionId ||
    turn.triggerKey !== identity.triggerKey ||
    turn.originalMessageId !== identity.messageId ||
    turn.originalMessage !== identity.content
  ) {
    throw new Error(`BTCC run replay does not match admitted Turn: ${turn.turnId}`);
  }
  if (!identity.wake) {
    if (turn.wakeIdentity) {
      throw new Error(`BTCC run replay does not match admitted Turn: ${turn.turnId}`);
    }
    return;
  }
  const wake = turn.wakeIdentity;
  if (
    !wake ||
    wake.triggerId !== identity.wake.triggerId ||
    wake.sourceTurnId !== identity.wake.sourceTurnId ||
    wake.authorizationRef !== identity.wake.authorizationRef ||
    (wake.resultScopeRef ?? undefined) !== identity.wake.resultScopeRef
  ) {
    throw new Error(`BTCC run replay does not match admitted Turn: ${turn.turnId}`);
  }
}
