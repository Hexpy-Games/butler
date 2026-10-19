import { useState } from "react";
import type { MessageRecord, ProgressRow } from "@/app/types.ts";
import { isTerminalProgressState } from "@/app/utils.ts";

type Held = { key: string; progress: string };

/**
 * The message that carries the running turn's live activity. Only a message that has not
 * settled (pending, thinking, streaming, retrying, or a draft) takes it; a delivered segment keeps
 * its settled summary and the live activity renders as its own row after it. When the turn's
 * message settles while it carries the activity (including a draft replaced by its delivered
 * record), it keeps the activity until the progress changes or detaches, so completion does not
 * flicker.
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
  const key = candidate ? candidate.turn_id || candidate.id : undefined;
  const progress = progressSignature(rows, state);
  let id: string | undefined;
  let nextAttached: string | undefined;
  let nextHeld: Held | null = null;
  if (candidate && isLive(candidate)) {
    id = candidate.id;
    nextAttached = key;
  } else if (candidate && key === attached) {
    const own = held?.key === key ? held : null;
    if (!own || own.progress === progress) {
      id = candidate.id;
      nextAttached = key;
      nextHeld = own ?? { key: key!, progress };
    }
  }
  if (nextAttached !== attached) setAttached(nextAttached);
  if (nextHeld !== held) setHeld(nextHeld);
  return id;
}

/** Progress identity by content: a re-created array with the same rows is the same progress. */
function progressSignature(rows: ProgressRow[], state: string | undefined): string {
  const last = rows.at(-1);
  return `${rows.length}|${last?.id ?? ""}|${last?.state ?? ""}|${state ?? ""}`;
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
  return !isTerminalProgressState(message.status ?? "");
}
