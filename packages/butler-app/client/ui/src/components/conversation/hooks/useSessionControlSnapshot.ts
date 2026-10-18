import { appCopy } from "@/app/copy.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import { notifyError } from "@/app/notifications.ts";
import { isServerBackedSessionId } from "@/app/sessionIds.ts";
import { useButlerStore } from "@/app/store.ts";
import type { ControlsLoadState, SessionControlsView } from "@/app/types.ts";
import type { ComposerControlPatch } from "./useComposerControls.ts";

export function useSessionControlSnapshot(activeChatId: string) {
  const [snapshot, setSnapshot] = useState<SessionControlsView | null>(null);
  const [loadState, setLoadState] =
    useState<ControlsLoadState>("loading");
  const activeChatRef = useRef(activeChatId);
  activeChatRef.current = activeChatId;

  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    if (!isServerBackedSessionId(activeChatId)) {
      // A conversation still being created shows the controls its draft chose.
      const { optimisticSessionStart: start, modelCatalog } = useButlerStore.getState();
      if (start?.id === activeChatId && start.controls) {
        setSnapshot({ session_id: activeChatId, controls: start.controls, revision: 0, catalog_generation: modelCatalog.generation });
      }
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
        notifyError(error, appCopy.interfacePanels.controlsFailed, {
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
          notifyError(error, appCopy.interfacePanels.controlsFailed, {
            id: `session-controls-${activeChatId}`,
          });
        });
    },
    [activeChatId],
  );

  /** Rereads the controls in place, without returning to the loading state. */
  const reload = useCallback(() => {
    if (!isServerBackedSessionId(activeChatId)) return;
    void api<SessionControlsView>(
      `/sessions/${encodeURIComponent(activeChatId)}/controls`,
    )
      .then((data) => {
        if (activeChatRef.current !== activeChatId) return;
        setSnapshot(data);
        setLoadState("ready");
      })
      .catch((error) => {
        notifyError(error, appCopy.interfacePanels.controlsFailed, {
          id: `session-controls-${activeChatId}`,
        });
      });
  }, [activeChatId]);

  return { loadState, persist, reload, snapshot };
}
