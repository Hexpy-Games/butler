import { persistedBrowserShell } from "./browserShellPersistence";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { BROWSER_CHAT_WIDTH, clampBrowserChatWidth } from "@/butler-ds";
import { raiseRightSlot } from "@/app/fileViewerState";

interface ConversationBrowser {
  open: boolean;
  lastTab?: string;
  /** When the browser last took the right slot (not persisted); the file viewer may hold it after. */
  raised?: number;
}
interface BrowserShellState {
  conversations: Record<string, ConversationBrowser>;
  chatWidth: number;
  setOpen: (session: string, open: boolean) => void;
  rememberTab: (session: string, id: string) => void;
  setChatWidth: (width: number) => void;
}

/** Local UI preferences; tab ownership and native browser state remain in the App bridge. */
export const useBrowserShellState = create<BrowserShellState>()(persist((set) => ({
  conversations: {},
  chatWidth: BROWSER_CHAT_WIDTH.default,
  setOpen: (session, open) => set((state) => ({
    conversations: { ...state.conversations, [session]: { ...state.conversations[session], open, ...(open ? { raised: raiseRightSlot() } : {}) } },
  })),
  rememberTab: (session, lastTab) => set((state) => ({
    conversations: { ...state.conversations, [session]: { ...state.conversations[session], open: state.conversations[session]?.open ?? false, lastTab } },
  })),
  setChatWidth: (width) => set({ chatWidth: clampBrowserChatWidth(width) }),
}), { name: "butler-browser-shell", partialize: (state) => persistedBrowserShell(state) }));
