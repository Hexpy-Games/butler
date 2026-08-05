import { useLayoutEffect } from "react";
import {
  readCachedComposerDraft,
  readLocalComposerDraft,
  writeCachedComposerDraft,
} from "@/app/composerDraftCache.ts";
import { useComposerStore } from "../composerStore.ts";

export function useComposerDraftSession(sessionId: string): void {
  useLayoutEffect(() => {
    const immediate = readLocalComposerDraft(sessionId);
    const revision = useComposerStore
      .getState()
      .activateDraftSession(sessionId, immediate?.text ?? "");
    void readCachedComposerDraft(sessionId).then((snapshot) => {
      const restored = useComposerStore.getState().restoreDraftSession({
        revision,
        sessionId,
        text: snapshot?.text ?? "",
      });
      if (restored && snapshot) {
        writeCachedComposerDraft(sessionId, snapshot.text);
      }
    });
  }, [sessionId]);
}
