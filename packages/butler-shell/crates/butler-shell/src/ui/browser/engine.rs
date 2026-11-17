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
    #[cfg(feature = "cef")]
    DevToolsRaw(Vec<u8>),
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

impl PageChange {
    /// Changes that only feed DevTools consumers: no tab state, nothing to redraw.
    pub(crate) fn is_quiet(&self) -> bool {
        match self {
            Self::DevToolsEvent { .. } => true,
            #[cfg(feature = "cef")]
            Self::DevToolsRaw(_) => true,
            _ => false,
        }
    }
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
    /// Sends one complete CDP message to `page`; its messages then arrive as `DevToolsRaw`.
    #[cfg(feature = "cef")]
    fn devtools_raw(&self, _page: &TabId, _message: &[u8]) {}
    fn devtools_raw_end(&self, _page: &TabId) {}
    /// Keeps `page` not hidden while awake, even when it is not the shown page.
    fn keep_awake(&mut self, _page: &TabId, _awake: bool) {}
    /// Whether `page` is the Agent's and held by it: its popups then open as pages of the Agent's own.
    fn set_hosted(&mut self, _page: &TabId, _hosted: bool) {}
    /// Lets `page` load if it was created with its loads held; the URL its main frame last
    /// tried to load meanwhile, if any.
    fn release_loads(&mut self, _page: &TabId) -> Option<String> {
        None
    }
    /// The URL `page`'s main frame last tried to load while its loads are held, if any.
    fn held_url(&self, _page: &TabId) -> Option<String> {
        None
    }
    /// The sites and exact hosts the Agent's policy lets `page`'s popups reach.
    fn set_popup_sites(&mut self, _page: &TabId, _sites: Vec<String>, _hosts: Vec<String>) {}
    /// Whether this build can browse (Electron's `enabled`).
    fn enabled(&self) -> bool;
    /// A page for `page`; `url` is empty for a blank page. `owner` keys the popup gate and
    /// downloads; `partition` keys the in-memory profile of a signed-out page.
    fn open(&mut self, page: &TabId, url: &str, profile: Profile, owner: &str, partition: &str);
    fn command(&mut self, page: &TabId, command: PageCommand);
    /// The page's size in logical pixels and the device scale (from PageCard's bounds).
    fn resize(&mut self, page: &TabId, size: gpui::Size<gpui::Pixels>, scale: f32);
    fn close(&mut self, page: &TabId);
    /// Binds `page` to a popup the engine created; true when it was decided the Agent's own.
    #[cfg(feature = "cef")]
    fn adopt(&mut self, page: &TabId, child: EngineChild) -> bool;
    fn allow_popup(&mut self, page: &TabId, url: &str);
    fn answer_dialog(&mut self, page: &TabId, id: u64, answer: DialogAnswer);
    fn change_owner(&mut self, _page: &TabId, _owner: &str) {}
    fn show(&mut self, _page: Option<&TabId>) {}
    fn frame_size(&self, _page: &TabId) -> Option<(usize, usize)> {
        None
    }
    /// What the page card draws for `page` (the frame surface, which owns its own input).
    fn surface(&self, page: &TabId, window: &mut Window, cx: &mut App) -> Option<AnyElement>;
}
