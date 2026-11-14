//! Page engines own their frame surface and input; the shell owns tab metadata.
use gpui::{AnyElement, App, SharedString, Window};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct TabId(pub(crate) SharedString);

pub(crate) enum PageCommand {
    Load(String),
    Back,
    Forward,
    Reload,
    Stop,
}

pub(crate) enum PageChange {
    Url(String),
    Title(String),
    Favicon(String),
    Loading(bool),
    History { can_back: bool, can_forward: bool },
    Crashed,
}

pub(crate) struct PageEvent {
    pub(crate) page: TabId,
    pub(crate) change: PageChange,
}

pub(crate) trait PageEngine: 'static {
    /// Whether this build can browse (Electron's `enabled`).
    fn enabled(&self) -> bool;
    /// A page for `page`; `url` is empty for a blank page.
    fn open(&mut self, page: &TabId, url: &str);
    fn command(&mut self, page: &TabId, command: PageCommand);
    /// The page's size in logical pixels and the device scale (from PageCard's bounds).
    fn resize(&mut self, page: &TabId, size: gpui::Size<gpui::Pixels>, scale: f32);
    fn close(&mut self, page: &TabId);
    /// What the page card draws for `page` (the frame surface, which owns its own input).
    fn surface(&self, page: &TabId, window: &mut Window, cx: &mut App) -> Option<AnyElement>;
}
