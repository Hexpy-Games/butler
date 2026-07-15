import { AgentConversationStore } from "../../conversation/store.ts";
import {
  btccAttemptIdForTurn,
  conversationSessionIdForDurableSession,
} from "../../conversation/session-admission.ts";
import { BtccRecoveryCaseStore } from "./recovery-case-store.ts";
import type { BtccTurnStateRecord } from "./turn-interruption-types.ts";

export function ensureAppInterruptionTurnAdmission(input: {
  recoveryCases: BtccRecoveryCaseStore;
  butlerData: string;
  durableSessionId: string;
  turnId: string;
  messageId: string;
  text: string;
  actor: "user" | "system";
  projectId?: string | null;
  now?: string;
}): BtccTurnStateRecord {
  const current = input.recoveryCases.readTurnState(input.turnId);
  if (current) return current;
  const conversations = new AgentConversationStore({ butlerData: input.butlerData });
  try {
    const existingTurn = conversations.readTurn(input.turnId);
    const turn = existingTurn ?? conversations.beginTurn({
      gateway: "app",
      externalSessionId: input.durableSessionId,
      sessionId: conversationSessionIdForDurableSession(input.durableSessionId),
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
    return input.recoveryCases.admitTurn({
      turnId: turn.id,
      sessionId: turn.session_id,
      attemptId: btccAttemptIdForTurn(turn.id),
      now: input.now,
    });
  } finally {
    conversations.close();
  }
}
