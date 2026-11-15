//! Page engines own their frame surface and input; the shell owns tab metadata.
use super::page_dialog::DialogAnswer;
#[cfg(feature = "cef")]
use super::page_dialog::EngineChild;
#[cfg(feature = "cef")]
use super::page_dialog::PageDialog;

use gpui::{AnyElement, App, SharedString, Window};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct TabId(pub(crate) SharedString);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Profile {
    SignedIn,
    SignedOut,
}

impl Profile {
    pub(crate) fn for_url(url: &str) -> Self {
        if url::Url::parse(url).is_ok_and(|u| {
            u.host_str() == Some("127.0.0.1")
                && ["/__o/", "/__p/"]
                    .iter()
                    .any(|prefix| u.path().starts_with(prefix))
        }) {
            Self::SignedOut
        } else {
            Self::SignedIn
        }
    }
}

pub(crate) enum PageCommand {
    Load(String),
    Back,
    Forward,
    Reload,
    Stop,
}

pub(crate) enum PageChange {
    DevToolsEvent {
        method: String,
        params: serde_json::Value,
    },
    Url(String),
    Title(String),
    Favicon(String),
    Loading(bool),
    History {
        can_back: bool,
        can_forward: bool,
    },
    #[cfg(feature = "cef")]
    PopupNewTab(String),
    #[cfg(feature = "cef")]
    PopupBlocked {
        url: String,
        reason: &'static str,
    },
    #[cfg(feature = "cef")]
    PopupOpened {
        child: EngineChild,
        url: String,
    },
    #[cfg(feature = "cef")]
    CloseRequested,
    #[cfg(feature = "cef")]
    Dialog(PageDialog),
    Crashed,
}

pub(crate) struct PageEvent {
    pub(crate) page: TabId,
    pub(crate) change: PageChange,
}

pub(crate) type DevToolsReply =
    futures::channel::oneshot::Receiver<anyhow::Result<serde_json::Value>>;

pub(crate) trait PageEngine: 'static {
    fn supports_devtools(&self) -> bool {
        false
    }
    fn devtools(&self, _page: &TabId, _method: &str, _params: &serde_json::Value) -> DevToolsReply {
        let (sender, receiver) = futures::channel::oneshot::channel();
        let _ = sender.send(Err(anyhow::anyhow!("DevTools unavailable")));
        receiver
    }
    /// Whether this build can browse (Electron's `enabled`).
    fn enabled(&self) -> bool;
    /// A page for `page`; `url` is empty for a blank page.
    fn open(&mut self, page: &TabId, url: &str, profile: Profile, owner: &str);
    fn open_embed(&mut self, page: &TabId, url: &str, profile: Profile) {
        self.open(page, url, profile, &page.0);
    }
    fn command(&mut self, page: &TabId, command: PageCommand);
    /// The page's size in logical pixels and the device scale (from PageCard's bounds).
    fn resize(&mut self, page: &TabId, size: gpui::Size<gpui::Pixels>, scale: f32);
    fn close(&mut self, page: &TabId);
    #[cfg(feature = "cef")]
    fn adopt(&mut self, page: &TabId, child: EngineChild);
    fn allow_popup(&mut self, page: &TabId, url: &str);
    fn answer_dialog(&mut self, page: &TabId, id: u64, answer: DialogAnswer);
    fn change_owner(&mut self, _page: &TabId, _owner: &str) {}
    fn show(&mut self, _page: Option<&TabId>) {}
    fn frame_size(&self, _page: &TabId) -> Option<(usize, usize)> {
        None
    }
    #[cfg(feature = "shots")]
    fn frame_pixel(&self, _page: &TabId, _x: usize, _y: usize) -> Option<[u8; 4]> {
        None
    }
    /// What the page card draws for `page` (the frame surface, which owns its own input).
    fn surface(&self, page: &TabId, window: &mut Window, cx: &mut App) -> Option<AnyElement>;
}
