//! The message column's width and where it sits (ConversationShell.module.css, conversationColumn.ts):
//! it centres on the scroller and, beside a docked aside or a tab rail, moves left only as far
//! as it must to stay clear, narrowing only when that would bring it within the clearance of
//! the card's leading edge.

/// The column's widest width (`--conversation-content-width: min(760px, ...)`).
pub(super) const CONTENT_MAX: f32 = 760.; // DS: ConversationShell.module.css:13
/// The default gutter of each side (`--conversation-shell-content-gutter: 7%`).
pub(super) const GUTTER_SHARE: f32 = 0.07; // DS: ConversationShell.module.css:12
/// The aside's width (`--conversation-aside-width`).
pub(super) const ASIDE_WIDTH: f32 = 272.; // DS: ConversationShell.module.css:19
/// The width at or below which the column takes an inset on each side instead of the gutter.
pub(super) const NARROW: f32 = 560.; // DS: ConversationShell.module.css:182

/// The gutter of the column (the `contentGutter` prop).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Gutter {
    /// A share of the conversation's width on each side.
    Share(f32),
    Px(f32),
}

impl Default for Gutter {
    fn default() -> Self {
        Self::Share(GUTTER_SHARE)
    }
}

/// How a narrow window or workspace sets the column.
#[derive(Clone, Copy, Debug)]
pub(super) struct Narrow {
    /// The viewport is at most 560px wide, or the workspace container is.
    pub(super) narrow: bool,
    /// `--adaptive-composer-inset` each side while narrow.
    pub(super) inset: f32,
}

/// `--conversation-content-width` for a conversation `width` wide.
pub(super) fn content_width(width: f32, gutter: Gutter, narrow: Narrow) -> f32 {
    if narrow.narrow {
        return width - 2. * narrow.inset;
    }
    let side = match gutter {
        Gutter::Share(share) => width * share,
        Gutter::Px(px) => px,
    };
    CONTENT_MAX.min(width - 2. * side)
}

/// What the column keeps clear of on its trailing side, and the clearance beyond it.
#[derive(Clone, Copy, Debug)]
pub(super) struct KeepOut {
    pub(super) keep_out: f32,
    pub(super) clearance: f32,
}

/// The column's width and `--conversation-column-shift` for a keep-out.
pub(super) fn column(width: f32, content: f32, keep: Option<KeepOut>) -> (f32, f32) {
    let Some(KeepOut {
        keep_out,
        clearance,
    }) = keep
    else {
        return (content, 0.);
    };
    let column = content.min(width - keep_out - clearance);
    (column, (keep_out - (width - column) / 2.).max(0.))
}
