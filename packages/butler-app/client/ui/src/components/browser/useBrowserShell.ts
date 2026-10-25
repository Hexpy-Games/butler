import { openHistory } from "./historyApi";
import { useEffect, useState, type RefObject } from "react";
import { useButlerStore } from "@/app/store";
import { useSidebarAutoCollapse } from "@/butler-ds";
import { browserCall, connectBrowser, useBrowserState } from "./browserBridge";
import { useBrowserShellState } from "./browserShellState";
import { useRightSlot } from "../file-viewer/useRightSlot";

export function useBrowserShell(root: RefObject<HTMLElement | null>, sidebarWidth: number) {
  const session = useButlerStore((state) => state.activeChatId);
  const view = useButlerStore((state) => state.view.kind);
  const chatWidth = useBrowserShellState((state) => state.chatWidth);
  const pane = useRightSlot(session);
  const paneOpen = pane !== null;
  const browserShown = pane === "browser";
  const autoCollapsed = useSidebarAutoCollapse(root, { enabled: paneOpen, sidebarWidth, chatWidth });
  const [peek, setPeek] = useState(false);
  useEffect(() => { setPeek(false); }, [session, view, autoCollapsed]);
  useEffect(() => {
    connectBrowser();
    const unsubscribeHistory = window.butlerBrowser?.onHistory?.(() => openHistory());
    return () => { unsubscribeHistory?.(); };
  }, []);
  useEffect(() => {
    if (!browserShown) return;
    const state = useBrowserState.getState();
    const tabs = state.tabs.filter((tab) => tab.owner === `conversation:${session}`);
    const last = useBrowserShellState.getState().conversations[session]?.lastTab;
    const target = tabs.find((tab) => tab.id === last) ?? tabs[0];
    if (target && target.id !== state.activeId) void browserCall("activate", { id: target.id });
  }, [browserShown, session]);
  return { pane, paneOpen, chatWidth, autoCollapsed, peek, setPeek };
}
