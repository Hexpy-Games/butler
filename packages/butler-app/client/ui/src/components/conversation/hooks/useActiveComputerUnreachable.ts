import { useEffect } from "react";
import { useComputerConnections } from "@/app/computerEvents";
import { useButlerStore } from "@/app/store";
import { sessionFromNavigation } from "@/app/utils";

export function activeComputerUnreachable() {
  const { activeChatId, navigation } = useButlerStore.getState();
  const chat = sessionFromNavigation(navigation, activeChatId);
  return chat?.computer_id && useComputerConnections.getState().states[chat.computer_id] === "unreachable"
    ? chat.computer_name ?? null
    : null;
}

export function useActiveComputerUnreachable() {
  const activeChatId = useButlerStore((store) => store.activeChatId);
  const computerId = useButlerStore((store) => sessionFromNavigation(store.navigation, activeChatId)?.computer_id);
  const name = useButlerStore((store) => sessionFromNavigation(store.navigation, activeChatId)?.computer_name);
  const state = useComputerConnections((store) => computerId ? store.states[computerId] : undefined);
  useEffect(() => {
    if (!computerId) return;
    let wasUnreachable = useComputerConnections.getState().states[computerId] === "unreachable";
    return useComputerConnections.subscribe(({ states }) => {
      const chat = useButlerStore.getState();
      if (chat.activeChatId !== activeChatId) return;
      if (states[computerId] === "unreachable") wasUnreachable = true;
      if (states[computerId] === "connected" && wasUnreachable) {
        wasUnreachable = false;
        void chat.reloadMessages(activeChatId);
      }
    });
  }, [activeChatId, computerId]);
  return state === "unreachable" ? name ?? null : null;
}
