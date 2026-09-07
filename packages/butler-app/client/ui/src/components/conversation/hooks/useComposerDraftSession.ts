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
      .activateDraftSession(sessionId, immediate?.text ?? "", immediate?.content_parts);
    void readCachedComposerDraft(sessionId).then((snapshot) => {
      const restored = useComposerStore.getState().restoreDraftSession({
        revision,
        sessionId,
        text: snapshot?.text ?? "",
        contentParts: snapshot?.content_parts,
      });
      if (restored && snapshot) {
        writeCachedComposerDraft(sessionId, snapshot.text, snapshot.content_parts);
      }
    });
  }, [sessionId]);
}
