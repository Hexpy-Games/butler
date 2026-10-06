import { create } from "zustand";
import { useButlerStore } from "@/app/store";
import { notifyStatus } from "@/app/notifications";
import { appCopy } from "@/app/copy";

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
    const store = useButlerStore.getState();
    if (state.focusRequest && state.focusRequest !== previous.focusRequest) {
      store.setView({ kind: "browser" }); void browserCall("open");
    }
    if (store.view.kind === "browser" || state.focusRequest !== previous.focusRequest) {
      const owner = state.tabs.find((tab) => tab.id === state.activeId)?.owner;
      if (owner?.startsWith("conversation:")) { if (store.activeChatId !== owner.slice(13)) store.setActiveChatId(owner.slice(13)); store.setRightOpen(true); }
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
  await browserCall("open");
  if (output) {
    await browserCall("create", { owner: `conversation:${output.sessionId}`, url: output.url });
    useButlerStore.getState().setActiveChatId(output.sessionId);
    useButlerStore.getState().setRightOpen(true);
  }
  useButlerStore.getState().setView({ kind: "browser" });
}

export async function focusBrowserTab(id: string, sessionId: string, fallback: string) {
  const state = await browserCall("state") as BrowserSnapshot | undefined;
  if (state?.tabs.some(tab => tab.id === id)) {
    useButlerStore.getState().setActiveChatId(sessionId);
    useButlerStore.getState().setView({ kind: "browser" });
    useButlerStore.getState().setRightOpen(true);
    await browserCall("open"); await browserCall("activate", { id });
  } else { window.open(fallback, "_blank", "noopener"); }
}
