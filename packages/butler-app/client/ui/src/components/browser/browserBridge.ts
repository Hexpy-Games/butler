import { browserFeatureEnabled } from "@/app/productFeatures";
import { create } from "zustand";
import { useButlerStore } from "@/app/store";
import { notifyStatus } from "@/app/notifications";
import { appCopy } from "@/app/copy";

export interface BrowserTab {
  id: string; owner: string; url: string; title: string; favicon: string;
  status: "idle" | "loading" | "crashed"; canBack: boolean; canForward: boolean;
}
export interface BrowserSnapshot {
  enabled: boolean; blocked: boolean; activeId: string | null; nativeCovered: boolean; tabs: BrowserTab[];
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
  if (browserFeatureEnabled && !unsubscribe && window.butlerBrowser) unsubscribe = window.butlerBrowser.subscribe((state) => useBrowserState.setState(state));
}
export async function browserCall(op: string, input?: unknown) {
  if (!browserFeatureEnabled) return undefined;
  try { return await window.butlerBrowser?.call(op, input); }
  catch { notifyStatus(appCopy.browser.failed, { tone: "error" }); return undefined; }
}
export async function openBrowser(output?: { url: string; sessionId: string }) {
  if (!browserFeatureEnabled || !window.butlerBrowser) return;
  connectBrowser();
  await browserCall("open");
  if (output) {
    await browserCall("create", { owner: `conversation:${output.sessionId}`, url: output.url });
    useButlerStore.getState().setRightOpen(true);
  }
  useButlerStore.getState().setView({ kind: "browser" });
}
