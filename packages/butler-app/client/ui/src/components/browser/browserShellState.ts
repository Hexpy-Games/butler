import { create } from "zustand";
import { persist } from "zustand/middleware";
import { BROWSER_CHAT_WIDTH, clampBrowserChatWidth } from "@/butler-ds";

interface ConversationBrowser {
  open: boolean;
  lastTab?: string;
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
    conversations: { ...state.conversations, [session]: { ...state.conversations[session], open } },
  })),
  rememberTab: (session, lastTab) => set((state) => ({
    conversations: { ...state.conversations, [session]: { ...state.conversations[session], open: state.conversations[session]?.open ?? false, lastTab } },
  })),
  setChatWidth: (width) => set({ chatWidth: clampBrowserChatWidth(width) }),
}), { name: "butler-browser-shell" }));
