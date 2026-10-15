/** Chat column width beside the browser pane (--browser-chat-width-min/max/default in tokens.css). */
export const BROWSER_CHAT_WIDTH = { min: 340, default: 400, max: 560 } as const;
/** The page (browser pane) never gets narrower than this while the sidebar is docked. */
export const MIN_PAGE_WIDTH = 720;
/** Width the page must gain back before a collapsed sidebar returns, so it never flaps. */
const RESTORE_MARGIN = 32;

export function clampBrowserChatWidth(width: number): number {
  return Math.round(Math.min(BROWSER_CHAT_WIDTH.max, Math.max(BROWSER_CHAT_WIDTH.min, width)));
}

/** The conversation's side panel: the browser pane (split) and the inspector never show together. */
export type ConversationSidePanel = "browser" | "inspector" | null;

/** Toggling one side panel closes the other. */
export function toggleConversationSidePanel(current: ConversationSidePanel, panel: Exclude<ConversationSidePanel, null>): ConversationSidePanel {
  return current === panel ? null : panel;
}

/**
 * Whether the docked sidebar should step aside so the page keeps MIN_PAGE_WIDTH: the page is what is
 * left of the shell after the sidebar and the chat column. Once collapsed it returns only when the page
 * would be RESTORE_MARGIN wider than the minimum.
 */
export function sidebarAutoCollapses({ shellWidth, sidebarWidth, chatWidth, collapsed, minPageWidth = MIN_PAGE_WIDTH }: {
  shellWidth: number;
  sidebarWidth: number;
  chatWidth: number;
  /** The current auto-collapse state (hysteresis). */
  collapsed: boolean;
  minPageWidth?: number;
}): boolean {
  const page = shellWidth - sidebarWidth - chatWidth;
  return collapsed ? page < minPageWidth + RESTORE_MARGIN : page < minPageWidth;
}
