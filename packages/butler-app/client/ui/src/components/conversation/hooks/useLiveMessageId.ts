import { useState } from "react";
import type { MessageRecord, ProgressRow } from "@/app/types.ts";

type Held = { id: string; rows: ProgressRow[]; state?: string };

/**
 * The message that carries the running turn's live activity. Only a message that is still
 * streaming (or pending, or a draft) takes it; a delivered segment keeps its settled summary and
 * the live activity renders as its own row after it. A message delivered while it carries the
 * activity keeps it until the progress changes or detaches, so completion does not flicker.
 */
export function useLiveMessageId(
  messages: MessageRecord[],
  turnId: string | undefined,
  active: boolean,
  rows: ProgressRow[],
  state: string | undefined,
): string | undefined {
  const [attached, setAttached] = useState<string>();
  const [held, setHeld] = useState<Held | null>(null);
  const candidate = active ? lastTurnMessage(messages, turnId) : undefined;
  let id: string | undefined;
  let nextHeld: Held | null = null;
  if (candidate && isLive(candidate)) {
    id = candidate.id;
  } else if (candidate && candidate.id === attached) {
    const own = held?.id === candidate.id ? held : null;
    if (!own || (own.rows === rows && own.state === state)) {
      id = candidate.id;
      nextHeld = own ?? { id: candidate.id, rows, state };
    }
  }
  if (id !== attached) setAttached(id);
  if (nextHeld !== held) setHeld(nextHeld);
  return id;
}

function lastTurnMessage(messages: MessageRecord[], turnId?: string): MessageRecord | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    if (turnId ? message.turn_id === turnId : isLive(message)) return message;
  }
  return undefined;
}

function isLive(message: MessageRecord): boolean {
  return message.status === "streaming" || message.status === "pending";
}
