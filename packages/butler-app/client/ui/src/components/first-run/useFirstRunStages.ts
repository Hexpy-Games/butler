import { useState } from "react";
import { PROVIDER_CARDS, type FirstRunProviderCardId, type LocalModelOption } from "@/app/setupProviders.ts";
import type { ConnectView, FirstRunMode } from "./useFirstRunFlow";
import type { useConnectionCommit } from "./useConnectionCommit";
import type { useSignIn } from "./useSignIn";

export function useFirstRunStages(mode: FirstRunMode) {
  const [view, setView] = useState<ConnectView>({ kind: "list" });
  // First run only: the optional import step sits between the connection and the finish.
  const [importDone, setImportDone] = useState(false);
  // AI step substeps: ① pick, ② sign in / key / model, ③ reply language. Import is one step (other AI tools).
  const [authDone, setAuthDone] = useState(false);
  const [replyDone, setReplyDone] = useState(false);
  const [advanceOnConnect, setAdvanceOnConnect] = useState(false);

  return { mode, view, setView, importDone, setImportDone, authDone, setAuthDone, replyDone, setReplyDone,
    advanceOnConnect, setAdvanceOnConnect };
}

export function connectionActions({ stages, commit, signIn, current, onCancel }: {
  stages: ReturnType<typeof useFirstRunStages>;
  commit: ReturnType<typeof useConnectionCommit>;
  signIn: ReturnType<typeof useSignIn>;
  current: FirstRunProviderCardId | null;
  onCancel?: () => void;
}) {
  const { setView, setImportDone, setAuthDone, setReplyDone, setAdvanceOnConnect } = stages;
  const backToList = () => {
    signIn.leave();
    commit.clear();
    setImportDone(false);
    setAuthDone(false);
    setReplyDone(false);
    setAdvanceOnConnect(false);
    setView({ kind: "list" });
  };
  return {
    ...stageActions(stages, commit),
    pick: (cardId: FirstRunProviderCardId) => {
      setAuthDone(false); setReplyDone(false); setAdvanceOnConnect(false);
      pickProvider(cardId, commit, setView);
    },
    cancel: () => {
      signIn.leave();
      onCancel?.();
    },
    backToList,
    showCustomModels: (options: LocalModelOption[], apiKey?: string) => setView({ kind: "customModels", options, apiKey }),
    connectKey: (cardId: FirstRunProviderCardId, credentialId: string) =>
      commit.submit({
        kind: "hosted", cardId, providerId: PROVIDER_CARDS[cardId].providerId ?? cardId, authType: "api_key", credentialId,
        // Routine presets are for a new AI; the AI already in use keeps its model and effort.
        keepDefaults: current === cardId,
      }),
  };
}

/** ② for a card: sign-in, its key form, or Other (models on this computer plus a server address). */
function connectionView(cardId: FirstRunProviderCardId): ConnectView {
  const kind = PROVIDER_CARDS[cardId].kind;
  return kind === "key" ? { kind: "key", cardId } : { kind };
}

/** Selecting a provider only opens its connection screen. */
function pickProvider(
  cardId: FirstRunProviderCardId,
  commit: ReturnType<typeof useConnectionCommit>,
  setView: (view: ConnectView) => void,
): void {
  commit.clear();
  setView(connectionView(cardId));

}

function stageActions(stages: ReturnType<typeof useFirstRunStages>, commit: ReturnType<typeof useConnectionCommit>) {
  const { view, setView, setImportDone, setAuthDone, setReplyDone, setAdvanceOnConnect, mode } = stages;
  return {
    /** ② done: the connection is live; ③ asks the reply language. */
    toReply: () => setAuthDone(true),
    /** ② for a model pick: connect, then open ③ once connected. */
    connectAndAdvance: (cardId: FirstRunProviderCardId, option: LocalModelOption, apiKey?: string) => {
      setAdvanceOnConnect(true);
      commit.submit({ kind: "local", cardId, option, apiKey });
    },
    /** ③ back to ②; the live connection stays, also after a resume (which starts on ③ with no ② view yet). */
    backFromReply: () => {
      const cardId = commit.connected?.cardId ?? commit.savedCardId;
      if (view.kind === "list" && cardId) setView(connectionView(cardId));
      setAuthDone(false);
    },
    backFromImport: () => setReplyDone(false),
    finishImport: () => setImportDone(true),
    /** Ready goes back to the import step on first run, else to ③. */
    backFromReady: () => { if (mode === "first-run") setImportDone(false); else setReplyDone(false); },
  };
}
