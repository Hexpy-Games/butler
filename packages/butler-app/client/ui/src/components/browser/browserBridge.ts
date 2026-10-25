import { conversationAgentTabs } from "./conversationAgentTabs";
import type { PageDialog } from "./BrowserDialog";
import { create } from "zustand";
import { useButlerStore } from "@/app/store";
import { notifyStatus } from "@/app/notifications";
import { appCopy } from "@/app/copy";
import type { PickedElement } from "./browserElements";
import { connectElementDrag, type ElementDragEvent } from "./elementDrag";
import { publicBrowserOwner, relevantConversationTab } from "./browserOwnership";
import { useBrowserShellState } from "./browserShellState";

export interface BrowserTab {
  popup?: { id: string; url: string }; dialog?: PageDialog | null; blockedPopup?: { url: string; site: string; reason: string } | null; opener?: string;
  privacyFrozen?: boolean;
  id: string; owner: string; url: string; title: string; favicon: string;
  preview?: string; picking?: boolean; selectionCount?: number;
  stills?: boolean; agent?: boolean; driven?: boolean; profile?: "signed_out" | "signed_in"; epoch?: number; holder?: "agent" | "user"; sticky?: boolean; waiting?: boolean; busy?: boolean; inUse?: boolean;
  /** You took the tab over while a Butler turn held it; clears when that turn ends. */
  paused?: boolean;
  /** When Butler last worked in this tab (ms since epoch); absent if it never has. */
  agentAt?: number;
  status: "idle" | "loading" | "crashed"; canBack: boolean; canForward: boolean;
  /** A sign-in step only the user can do (mfa, passkey, captcha, secure_keypad, unknown_form). */
  signinStep?: string;
  payStep?: string;
  /** "로그인 저장" after a takeover sign-in; never carries the password. */
  saveOffer?: { username: string; host: string };
}
export interface BrowserSnapshot {
  /** Saved tabs have finished loading; an empty list is authoritative only then. */
  restored: boolean; enabled: boolean; blocked: boolean; activeId: string | null; nativeCovered: boolean; focusRequest?: string; tabs: BrowserTab[];
}
export interface BrowserFrame { tab: string; seq: number; bytes: Uint8Array; masked: boolean }
interface BrowserBridge {
  onFrame: (tabId: string, handler: (frame: BrowserFrame) => void, widthPx?: number) => () => void;
  call: (op: string, input?: unknown) => Promise<unknown>;
  subscribe: (handler: (state: BrowserSnapshot) => void) => () => void;
  onPointer: (handler: (point: { x: number; y: number } | null) => void) => () => void;
  onElementDrag: (handler: (event: ElementDragEvent) => void) => () => void;
  onSelectionAction: (handler: (event: { op: string; elements: PickedElement[] }) => void) => () => void;
  onDownload?: (handler: (event: { type: string; session: string; reason?: string }) => void) => () => void;
  onHistory?: (handler: () => void) => () => void;
  onStill?: (handler: (receipt: { id: string; session: string }) => void) => () => void;
  onAddress: (handler: () => void) => () => void;
}
declare global { interface Window { butlerBrowser?: BrowserBridge } }
export const useBrowserState = create<BrowserSnapshot>(() => ({
  restored: false, enabled: false, blocked: false, activeId: null, nativeCovered: false, tabs: [],
}));
let unsubscribe: (() => void) | undefined;
let downloadUnsubscribe: (() => void) | undefined;
export function connectBrowser() {
  connectElementDrag();
  if (!downloadUnsubscribe) downloadUnsubscribe = window.butlerBrowser?.onDownload?.(event => {
    const store = useButlerStore.getState();
    if (!publicBrowserOwner(`conversation:${event.session}`, store.navigation)) return;
    if (event.type === "download_completed") {
      if (store.activeChatId === event.session) void store.refreshSessionView(event.session, { snapshot: true });
      notifyStatus(appCopy.browser.downloadSaved);
    } else {
      const label = event.reason === "download_file_limit" ? appCopy.browser.downloadFileLimit
        : event.reason === "download_session_limit" ? appCopy.browser.downloadSessionLimit : appCopy.browser.downloadFailed;
      notifyStatus(label, { tone: "error" });
    }
  });
  if (!unsubscribe && window.butlerBrowser) unsubscribe = window.butlerBrowser.subscribe((state) => {
    const previous = useBrowserState.getState();
    useBrowserState.setState(state);
    const active = state.tabs.find((tab) => tab.id === state.activeId);
    const navigation = useButlerStore.getState().navigation;
    const activeOwner = active && publicBrowserOwner(active.owner, navigation);
    if (active && activeOwner) {
      const session = activeOwner;
      const shell = useBrowserShellState.getState();
      if (shell.conversations[session]?.lastTab !== active.id) shell.rememberTab(session, active.id);
    }
    if (state.focusRequest && state.focusRequest !== previous.focusRequest) {
      const requested = state.tabs.find((tab) => tab.id === state.focusRequest);
      const session = requested && publicBrowserOwner(requested.owner, navigation);
      const current = useButlerStore.getState();
      if (requested?.owner === "mine") {
        current.setView({ kind: "browser" });
        void browserCall("activate", { id: requested.id });
      }
      if (requested && session && current.view.kind === "session" && current.activeChatId === session) {
        useBrowserShellState.getState().setOpen(session, true);
        useBrowserShellState.getState().rememberTab(session, requested.id);
        void browserCall("activate", { id: requested.id });
      }
    }
  });
}
export async function browserCall(op: string, input?: unknown) {
  try { return await window.butlerBrowser?.call(op, input); }
  catch { notifyStatus(appCopy.browser.failed, { tone: "error" }); return undefined; }
}
export async function openBrowser(output?: { url: string; sessionId: string; previewId?: string }) {
  if (!window.butlerBrowser) return;
  connectBrowser();
  if (output) {
    if (!publicBrowserOwner(`conversation:${output.sessionId}`, useButlerStore.getState().navigation)) return;
    const id = await browserCall("create", { owner: `conversation:${output.sessionId}`, url: output.url, preview_id: output.previewId });
    if (typeof id === "string") await openConversationBrowser(output.sessionId, id);
    return;
  }
  useButlerStore.getState().setView({ kind: "browser" });
  await browserCall("open");
}

export async function openConversationBrowser(session: string, requestedTab?: string) {
  if (!window.butlerBrowser || !publicBrowserOwner(`conversation:${session}`, useButlerStore.getState().navigation)) return;
  connectBrowser();
  const store = useButlerStore.getState();
  // A link from the open conversation keeps its view; only another conversation is opened.
  if (store.activeChatId !== session || store.view.kind !== "session") store.openSession(session);
  const shell = useBrowserShellState.getState();
  shell.setOpen(session, true);
  const snapshot = await browserCall("open") as BrowserSnapshot | undefined;
  const all = snapshot?.tabs ?? [];
  const rolled = conversationAgentTabs(session, all, store.sessionViews);
  const tabs = all.filter(tab => tab.owner === `conversation:${session}` || rolled.includes(tab));
  const target = tabs.find(tab => tab.id === requestedTab)?.id
    ?? relevantConversationTab(tabs, shell.conversations[session]?.lastTab)?.id;

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
  else void openLink(fallback);
}

/**
 * A link a conversation's message shows (answer cards, source lines, actions, the image viewer) opens in
 * that conversation's browser, grouped with its tabs, like the agent's own tabs. Without a public
 * conversation it is an ordinary link.
 */
export async function openConversationLink(url: string, sessionId: string | undefined) {
  const owned = sessionId && publicBrowserOwner(`conversation:${sessionId}`, useButlerStore.getState().navigation);
  if (window.butlerBrowser && owned && /^https?:/iu.test(url)) await openBrowser({ url, sessionId: owned });
  else await openLink(url);
}

/** Desktop links share the main-process opener; remote clients keep web navigation. */
export async function openLink(url: string) {
  if (window.butlerBrowser && /^https?:/iu.test(url)) {
    connectBrowser();
    await browserCall("open-link", { url });
  } else window.open(url, "_blank", "noopener,noreferrer");
}
