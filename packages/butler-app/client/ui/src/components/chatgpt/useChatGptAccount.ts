import { onChatGptEvent } from "@/app/chatGptEvents";
import { useButlerStore } from "@/app/store";
import type { ModelCatalogView, TimelineEvent } from "@/app/types";
import { useCallback, useEffect, useState } from "react";
import { api, subscribeLiveEvents } from "@/app/api";
import { chatGptAccount, type ChatGptAccountView } from "@/app/setupSignIn";
/** Account reads follow mount, focus and the agent's account-change signal. */
export function useChatGptAccount({ standalone = false }: { standalone?: boolean } = {}) {
  const [account, setAccount] = useState<ChatGptAccountView | null>(null);
  const refresh = useCallback(async () => { const next = await chatGptAccount(); setAccount(next); return next; }, []);
  useEffect(() => {
    const read = () => { void refresh().catch(() => {}); };
    read(); window.addEventListener("focus", read);
    const receive = (event: TimelineEvent) => { if (event.type === "setup.chatgpt_account_changed") {
      read();
      void api<ModelCatalogView>("/model-catalog").then(catalog => useButlerStore.getState().setModelCatalog(catalog)).catch(() => {});
    } };
    const stop = standalone ? subscribeLiveEvents(0, receive, () => {}) : onChatGptEvent(receive);
    return () => { window.removeEventListener("focus", read); stop(); };
  }, [refresh, standalone]);
  return { account, refresh, setAccount };
}
