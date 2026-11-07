//! The new chat: `EmptyState`, `EpicEmptyState`, `emptyStateSuggestions`, `mainScreenTheme` and
//! `useConversationWallpaper` (poster stills on WallpaperStage).
use gpui::{AnyElement, App, IntoElement as _, Window};

/// Where the new chat opens.
#[derive(Clone, Copy, Default)]
pub(crate) struct EmptyCtx<'a> {
    pub(crate) project_id: Option<&'a str>,
    pub(crate) epic_id: Option<&'a str>,
}

/// The new-chat screen behind the composer.
pub(crate) fn empty_state(ctx: EmptyCtx<'_>, window: &mut Window, cx: &mut App) -> AnyElement {
    let _ = (ctx, window, cx);
    gpui::Empty.into_any_element()
}
