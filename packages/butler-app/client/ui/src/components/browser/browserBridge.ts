import { create } from "zustand";
import { useButlerStore } from "@/app/store";
import { notifyStatus } from "@/app/notifications";
import { appCopy } from "@/app/copy";
import { useBrowserShellState } from "./browserShellState";

export interface BrowserTab {
  id: string; owner: string; url: string; title: string; favicon: string;
  stills?: boolean; agent?: boolean; profile?: "signed_out" | "signed_in"; epoch?: number; holder?: "agent" | "user"; sticky?: boolean; waiting?: boolean; busy?: boolean;
  status: "idle" | "loading" | "crashed"; canBack: boolean; canForward: boolean;
}
export interface BrowserSnapshot {
  enabled: boolean; blocked: boolean; activeId: string | null; nativeCovered: boolean; focusRequest?: string; tabs: BrowserTab[];
}
interface BrowserBridge {
  call: (op: string, input?: unknown) => Promise<unknown>;
  subscribe: (handler: (state: BrowserSnapshot) => void) => () => void;
  onPointer: (handler: (point: { x: number; y: number } | null) => void) => () => void;
  onAddress: (handler: () => void) => () => void;
}
declare global { interface Window { butlerBrowser?: BrowserBridge } }
export const useBrowserState = create<BrowserSnapshot>(() => ({
  enabled: false, blocked: false, activeId: null, nativeCovered: false, tabs: [],
}));
let unsubscribe: (() => void) | undefined;
export function connectBrowser() {
  if (!unsubscribe && window.butlerBrowser) unsubscribe = window.butlerBrowser.subscribe((state) => {
    const previous = useBrowserState.getState();
    useBrowserState.setState(state);
    const active = state.tabs.find((tab) => tab.id === state.activeId);
    if (active?.owner.startsWith("conversation:")) {
      const session = active.owner.slice(13);
      const shell = useBrowserShellState.getState();
      if (shell.conversations[session]?.lastTab !== active.id) shell.rememberTab(session, active.id);
    }
    if (state.focusRequest && state.focusRequest !== previous.focusRequest && active) {
      if (active.owner.startsWith("conversation:")) void openConversationBrowser(active.owner.slice(13), active.id);
      else void openBrowser();
    }
  });
}
export async function browserCall(op: string, input?: unknown) {
  try { return await window.butlerBrowser?.call(op, input); }
  catch { notifyStatus(appCopy.browser.failed, { tone: "error" }); return undefined; }
}
export async function openBrowser(output?: { url: string; sessionId: string }) {
  if (!window.butlerBrowser) return;
  connectBrowser();
  if (output) {
    const id = await browserCall("create", { owner: `conversation:${output.sessionId}`, url: output.url });
    if (typeof id === "string") await openConversationBrowser(output.sessionId, id);
    return;
  }
  useButlerStore.getState().setView({ kind: "browser" });
  await browserCall("open");
}

export async function openConversationBrowser(session: string, requestedTab?: string) {
  if (!window.butlerBrowser) return;
  connectBrowser();
  const store = useButlerStore.getState();
  store.setRightOpen(false);
  store.openSession(session);
  const shell = useBrowserShellState.getState();
  shell.setOpen(session, true);
  const snapshot = await browserCall("open") as BrowserSnapshot | undefined;
  const tabs = snapshot?.tabs.filter((tab) => tab.owner === `conversation:${session}`) ?? [];
  const remembered = requestedTab ?? shell.conversations[session]?.lastTab;
  const target = tabs.find((tab) => tab.id === remembered)?.id ?? tabs[0]?.id
    ?? await browserCall("create", { owner: `conversation:${session}`, profile: "signed_out" });
  // Switching away while opening must not steal another conversation's native view.
  const current = useButlerStore.getState();
  if (typeof target === "string" && current.activeChatId === session && current.view.kind === "session") {
    shell.rememberTab(session, target);
    await browserCall("activate", { id: target });
  }
}

export async function focusBrowserTab(id: string, sessionId: string, fallback: string) {
  const state = await browserCall("state") as BrowserSnapshot | undefined;
  if (state?.tabs.some((tab) => tab.id === id)) await openConversationBrowser(sessionId, id);
  else window.open(fallback, "_blank", "noopener");
}
