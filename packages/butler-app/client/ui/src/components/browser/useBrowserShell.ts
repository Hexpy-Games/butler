import { useEffect, useState, type RefObject } from "react";
import { useButlerStore } from "@/app/store";
import { useSidebarAutoCollapse } from "@/butler-ds";
import { browserCall, connectBrowser, useBrowserState } from "./browserBridge";
import { useBrowserShellState } from "./browserShellState";

export function useBrowserShell(root: RefObject<HTMLElement | null>, sidebarWidth: number) {
  const session = useButlerStore((state) => state.activeChatId);
  const view = useButlerStore((state) => state.view.kind);
  const rememberedOpen = useBrowserShellState((state) => Boolean(state.conversations[session]?.open));
  const chatWidth = useBrowserShellState((state) => state.chatWidth);
  const enabled = useBrowserState((state) => state.enabled);
  const paneOpen = view === "session" && rememberedOpen && enabled && Boolean(window.butlerBrowser);
  const autoCollapsed = useSidebarAutoCollapse(root, { enabled: paneOpen, sidebarWidth, chatWidth });
  const [peek, setPeek] = useState(false);
  useEffect(() => { setPeek(false); }, [session, view, autoCollapsed]);
  useEffect(() => {
    connectBrowser();
    return useButlerStore.subscribe((state, previous) => {
      if (state.rightOpen && !previous.rightOpen && state.view.kind === "session") {
        useBrowserShellState.getState().setOpen(state.activeChatId, false);
      }
    });
  }, []);
  useEffect(() => {
    if (!paneOpen) return;
    useButlerStore.getState().setRightOpen(false);
    const state = useBrowserState.getState();
    const tabs = state.tabs.filter((tab) => tab.owner === `conversation:${session}`);
    const last = useBrowserShellState.getState().conversations[session]?.lastTab;
    const target = tabs.find((tab) => tab.id === last) ?? tabs[0];
    if (target && target.id !== state.activeId) void browserCall("activate", { id: target.id });
  }, [paneOpen, session]);
  return { paneOpen, chatWidth, autoCollapsed, peek, setPeek };
}
