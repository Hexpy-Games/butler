import { useEffect } from "react";
import { useDocumentAttended } from "@/app/documentAttention.ts";
import { findSessionSummary } from "@/app/optimisticSession.ts";
import { markSessionRead } from "@/app/sessionReads.ts";
import { readDue } from "@/app/space/unread.ts";
import { useButlerStore } from "@/app/store.ts";

/**
 * Marks the open chat read while this window is shown and focused. It fires
 * when the chat becomes unread with its turn ended (or when the user comes
 * back to it), so a streaming turn writes nothing until it finishes.
 */
export function useSessionReadMarker(): void {
  const attended = useDocumentAttended();
  const sessionId = useButlerStore((state) => state.view.kind === "session" ? state.activeChatId : "");
  const due = useButlerStore((state) =>
    sessionId !== "" && readDue(findSessionSummary(state.navigation, sessionId)));
  useEffect(() => {
    if (attended && due) void markSessionRead(sessionId);
  }, [attended, due, sessionId]);
}
