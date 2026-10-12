import { useState } from "react";
import { PROVIDER_CARDS, type FirstRunProviderCardId, type LocalModelOption } from "@/app/setupProviders.ts";
import type { ConnectView, FirstRunMode, ImportStage } from "./useFirstRunFlow";
import type { useConnectionCommit } from "./useConnectionCommit";
import type { useSignIn } from "./useSignIn";
import type { useLocalModelServers } from "./useLocalModelServers";

export function useFirstRunStages(mode: FirstRunMode) {
  const [view, setView] = useState<ConnectView>({ kind: "list" });
  // First run only: the optional import step sits between the connection and the finish.
  const [importDone, setImportDone] = useState(false);
  // AI step substeps: ① pick, ② sign in / key / model, ③ reply language. Import: ① AI tools, ② browsers.
  const [authDone, setAuthDone] = useState(false);
  const [replyDone, setReplyDone] = useState(false);
  const [advanceOnConnect, setAdvanceOnConnect] = useState(false);
  const [importStage, setImportStage] = useState<ImportStage>("agents");

  return { mode, view, setView, importDone, setImportDone, authDone, setAuthDone, replyDone, setReplyDone,
    advanceOnConnect, setAdvanceOnConnect, importStage, setImportStage };
}

export function connectionActions({ stages, commit, signIn, local, current, onCancel }: {
  stages: ReturnType<typeof useFirstRunStages>;
  commit: ReturnType<typeof useConnectionCommit>;
  signIn: ReturnType<typeof useSignIn>;
  local: ReturnType<typeof useLocalModelServers>;
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
      const only = onlyModel(cardId, local.options);
      if (only) {
        setView(connectionView(cardId)); setAdvanceOnConnect(true);
        commit.submit({ kind: "local", cardId, option: only });
      } else pickProvider(cardId, commit, signIn, setView);
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
    connectLocal: (cardId: FirstRunProviderCardId, option: LocalModelOption, apiKey?: string) =>
      commit.submit({ kind: "local", cardId, option, apiKey }),
  };
}

/**
 * Skip rule (pending owner confirmation): "This computer" with exactly one detected model connects it
 * right from ① and opens ③ once connected; Back from ③ still shows ② with that connection.
 */
function onlyModel(cardId: FirstRunProviderCardId, options: LocalModelOption[]): LocalModelOption | null {
  return PROVIDER_CARDS[cardId].kind === "local" && options.length === 1 ? options[0]! : null;
}

/** ② for a card; a custom server that is already connected shows its connection, not the address form. */
function connectionView(cardId: FirstRunProviderCardId, connected = false): ConnectView {
  const kind = PROVIDER_CARDS[cardId].kind;
  if (kind === "signin" || kind === "local") return { kind };
  if (kind === "key") return { kind: "key", cardId };
  return connected ? { kind: "customModels", options: [] } : { kind: "custom" };
}

/** Preserve the existing option kinds and start sign-in only after an explicit pick. */
function pickProvider(
  cardId: FirstRunProviderCardId,
  commit: ReturnType<typeof useConnectionCommit>,
  signIn: ReturnType<typeof useSignIn>,
  setView: (view: ConnectView) => void,
): void {
  commit.clear();
  setView(connectionView(cardId));
  if (PROVIDER_CARDS[cardId].kind === "signin") void signIn.start();
}

function stageActions(stages: ReturnType<typeof useFirstRunStages>, commit: ReturnType<typeof useConnectionCommit>) {
  const { view, setView, setImportDone, setAuthDone, setReplyDone, setAdvanceOnConnect, importStage, setImportStage, mode } = stages;
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
      if (view.kind === "list" && cardId) setView(connectionView(cardId, true));
      setAuthDone(false);
    },
    toBrowsers: () => setImportStage("browsers"),
    backFromImport: () => { if (importStage === "browsers") setImportStage("agents"); else setReplyDone(false); },
    finishImport: () => setImportDone(true),
    /** Ready goes back to the import step on first run, else to ③. */
    backFromReady: () => { if (mode === "first-run") { setImportDone(false); setImportStage("browsers"); } else setReplyDone(false); },
  };
}
