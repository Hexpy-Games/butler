//! The conversation frame's rules (conversationFrame.ts): the chat column's width beside the
//! browser pane, which side panel is open, and when the docked sidebar steps aside so the page
//! keeps its minimum width.

/// The chat column's width beside the browser pane (`--browser-chat-width-min/default/max`).
pub const CHAT_WIDTH_MIN: f32 = 340.; // DS: conversationFrame.ts:2
pub const CHAT_WIDTH_DEFAULT: f32 = 400.; // DS: conversationFrame.ts:2
pub const CHAT_WIDTH_MAX: f32 = 560.; // DS: conversationFrame.ts:2
/// The page (browser pane) never gets narrower than this while the sidebar is docked.
pub const MIN_PAGE_WIDTH: f32 = 720.; // DS: conversationFrame.ts:4
/// Width the page must gain back before a collapsed sidebar returns, so it never flaps.
const RESTORE_MARGIN: f32 = 32.; // DS: conversationFrame.ts:6

pub fn clamp_chat_width(width: f32) -> f32 {
    width.clamp(CHAT_WIDTH_MIN, CHAT_WIDTH_MAX).round()
}

/// The conversation's side panel: the browser pane (split) and the inspector never show together.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SidePanel {
    Browser,
    Inspector,
}

/// Toggling one side panel closes the other.
pub fn toggle_side_panel(current: Option<SidePanel>, panel: SidePanel) -> Option<SidePanel> {
    (current != Some(panel)).then_some(panel)
}

/// What the auto-collapse reads: the shell, the sidebar and the chat column, and the state now.
#[derive(Clone, Copy, Debug)]
pub struct AutoCollapse {
    pub shell_width: f32,
    pub sidebar_width: f32,
    pub chat_width: f32,
    /// The current auto-collapse state (hysteresis).
    pub collapsed: bool,
    pub min_page_width: f32,
}

/// Whether the docked sidebar should step aside so the page keeps `min_page_width`: the page is
/// what is left of the shell after the sidebar and the chat column. Once collapsed it returns
/// only when the page would be `RESTORE_MARGIN` wider than the minimum.
pub fn sidebar_auto_collapses(input: AutoCollapse) -> bool {
    let page = input.shell_width - input.sidebar_width - input.chat_width;
    if input.collapsed {
        page < input.min_page_width + RESTORE_MARGIN
    } else {
        page < input.min_page_width
    }
}

/// The keyboard step of the chat-column handle (`KEY_STEP`, tripled with Shift).
pub const KEY_STEP: f32 = 16.; // DS: AdaptiveShellSplit.tsx:30

/// `--sidebar-width` and `--right-panel-width` before the host sets them.
pub const SIDEBAR_WIDTH: f32 = 304.; // DS: tokens.css:337
pub const RIGHT_PANEL_WIDTH: f32 = 376.; // DS: tokens.css:345
