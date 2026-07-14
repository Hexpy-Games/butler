import { useCallback, useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { notifyError } from "@/app/notifications.ts";
import { isServerBackedSessionId } from "@/app/sessionIds.ts";
import type { SessionControlsView } from "@/app/types.ts";
import type { ComposerControlPatch } from "./useComposerControls.ts";

export type ControlsLoadState = "loading" | "ready" | "error";

export function useSessionControlSnapshot(activeChatId: string) {
  const [snapshot, setSnapshot] = useState<SessionControlsView | null>(null);
  const [loadState, setLoadState] =
    useState<ControlsLoadState>("loading");

  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    if (!isServerBackedSessionId(activeChatId)) {
      setLoadState("ready");
      return;
    }
    setLoadState("loading");
    api<SessionControlsView>(
      `/sessions/${encodeURIComponent(activeChatId)}/controls`,
    )
      .then((data) => {
        if (cancelled) return;
        setSnapshot(data);
        setLoadState("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadState("error");
        notifyError(error, "Session controls failed", {
          id: `session-controls-${activeChatId}`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [activeChatId]);

  const persist = useCallback(
    (partial: ComposerControlPatch) => {
      if (!isServerBackedSessionId(activeChatId)) return;
      void api<SessionControlsView>(
        `/sessions/${encodeURIComponent(activeChatId)}/controls`,
        {
          method: "PATCH",
          body: JSON.stringify(partial),
        },
      )
        .then((data) => {
          setSnapshot(data);
          setLoadState("ready");
        })
        .catch((error) => {
          notifyError(error, "Session controls failed", {
            id: `session-controls-${activeChatId}`,
          });
        });
    },
    [activeChatId],
  );

  return { loadState, persist, snapshot };
}
