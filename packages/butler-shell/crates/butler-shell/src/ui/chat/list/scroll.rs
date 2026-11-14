//! `conversationScrollUtils.ts` (used by `useConversationAutoScroll.ts`): the bottom lock.
use gpui::{ListState, Pixels, px};

/// `BOTTOM_LOCK_THRESHOLD`
const BOTTOM_LOCK_THRESHOLD: f32 = 120.;

/// `conversationBottomLockAfterScroll` for a user scroll: scrolling up releases the lock at
/// once; returning within the threshold of the end, or sitting at it, re-locks it; other
/// scrolls keep it while it is on.
fn pinned_after_scroll(
    was_pinned: bool,
    following: bool,
    moved_up: bool,
    distance: Pixels,
) -> bool {
    if following {
        return true;
    }
    if moved_up {
        return false;
    }
    was_pinned || distance < px(BOTTOM_LOCK_THRESHOLD)
}

/// One user scroll: the offset it left (`last` moves to it), whether it moved up, and the
/// distance from the end; returns the new `pinned`. The list's y offset is negative (how far
/// the content scrolled), so a larger value is a view nearer the top.
pub(super) fn after(list: &ListState, last: &mut Pixels, pinned: bool, following: bool) -> bool {
    let offset = list.scroll_px_offset_for_scrollbar().y;
    let distance = list.max_offset_for_scrollbar().y + offset;
    let moved_up = offset > *last;
    *last = offset;
    pinned_after_scroll(pinned, following, moved_up, distance)
}
