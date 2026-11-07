/** Chat column width beside the browser pane (--browser-chat-width-min/default in tokens.css). */
export const BROWSER_CHAT_WIDTH = { min: 340, default: 400 } as const;
/** The pane beside the chat never gets narrower than a phone screen (--browser-pane-width-min in tokens.css). */
export const BROWSER_PANE_MIN_WIDTH = 375;
/** The page (browser pane) at the default chat width never gets narrower than this while the sidebar is docked. */
export const MIN_PAGE_WIDTH = 720;
/** Width the page must gain back before a collapsed sidebar returns, so it never flaps. */
const RESTORE_MARGIN = 32;

/**
 * At least the chat minimum; leaves the pane its minimum out of `room`, the width the chat column and the pane share
 * (the chat minimum wins when both cannot fit). Without `room` only the minimum applies.
 */
export function clampBrowserChatWidth(width: number, room = Number.POSITIVE_INFINITY): number {
  return Math.round(Math.max(BROWSER_CHAT_WIDTH.min, Math.min(room - BROWSER_PANE_MIN_WIDTH, width)));
}

/** The conversation's side panel: the browser pane (split) and the inspector never show together. */
export type ConversationSidePanel = "browser" | "inspector" | null;

/** Toggling one side panel closes the other. */
export function toggleConversationSidePanel(current: ConversationSidePanel, panel: Exclude<ConversationSidePanel, null>): ConversationSidePanel {
  return current === panel ? null : panel;
}

/**
 * Whether the docked sidebar should step aside so the page keeps MIN_PAGE_WIDTH: the page is what is
 * left of the shell after the sidebar and the chat column at its default width, so only a window resize
 * moves the sidebar, never a drag. Once collapsed it returns only when the page would be RESTORE_MARGIN
 * wider than the minimum.
 */
export function sidebarAutoCollapses({ shellWidth, sidebarWidth, collapsed, minPageWidth = MIN_PAGE_WIDTH }: {
  shellWidth: number;
  sidebarWidth: number;
  /** The current auto-collapse state (hysteresis). */
  collapsed: boolean;
  minPageWidth?: number;
}): boolean {
  const page = shellWidth - sidebarWidth - BROWSER_CHAT_WIDTH.default;
  return collapsed ? page < minPageWidth + RESTORE_MARGIN : page < minPageWidth;
}
