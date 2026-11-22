//! The page engine starts on the first browser use (a tab that gets a URL, or an Agent page), not
//! with the App or an empty tab.
use futures::channel::mpsc;
use gpui::{AnyElement, App, Window};

use super::engine::{PageCommand, PageEngine, PageEvent, Profile, TabId};
use super::model::BrowserState;
use super::page_dialog::DialogAnswer;
use super::placeholder::PlaceholderEngine;

/// The engine before its start: it has no pages, and it answers what the started engine will.
pub(super) struct Unstarted;

impl PageEngine for Unstarted {
    fn supports_devtools(&self) -> bool {
        cfg!(feature = "cef")
    }
    /// Both engines [`engine`] can start browse (CEF, else the placeholder).
    fn enabled(&self) -> bool {
        true
    }
    fn open(&mut self, _: &TabId, _: &str, _: Profile, _: &str, _: &str) {}
    fn command(&mut self, _: &TabId, _: PageCommand) {}
    fn resize(&mut self, _: &TabId, _: gpui::Size<gpui::Pixels>, _: f32) {}
    fn close(&mut self, _: &TabId) {}
    #[cfg(feature = "cef")]
    fn adopt(&mut self, _: &TabId, _: super::page_dialog::EngineChild) -> bool {
        false
    }
    fn allow_popup(&mut self, _: &TabId, _: &str) {}
    fn answer_dialog(&mut self, _: &TabId, _: u64, _: DialogAnswer) {}
    fn surface(&self, _: &TabId, _: &mut Window, _: &mut App) -> Option<AnyElement> {
        None
    }
}

impl BrowserState {
    /// An empty tab opened: read the engine's framework from disk on a background thread, once, so
    /// the first page does not wait on it (a cold disk takes ~0.9 s on the UI thread otherwise).
    pub(super) fn prepare_engine(&mut self) {
        if self.starter.is_some() && !std::mem::replace(&mut self.preparing, true) {
            #[cfg(feature = "cef")]
            if let Ok((framework, _)) = super::cef::config::locations() {
                std::thread::spawn(move || butler_cef_host::osr::preload_framework(&framework));
            }
        }
    }

    /// Starts the page engine once, on the first tab that gets a URL or the first Agent page, and
    /// opens the tabs created before it; later calls do nothing.
    pub(super) fn start_engine(&mut self, cx: &mut App) {
        if let Some((sender, adapter)) = self.starter.take() {
            self.engine = engine(sender, adapter, cx);
            // Tabs created before the start were opened on `Unstarted`: open them on the engine now.
            for tab in &self.tabs {
                let key = super::area::owner_key(&tab.owner);
                self.engine.open(&tab.id, &tab.url, tab.profile, &key, &key);
            }
        }
    }
}

/// `adapter`: the LUID of the GPU adapter that draws the page frames (`browser::init_window`).
fn engine(
    sender: mpsc::UnboundedSender<PageEvent>,
    adapter: Option<u64>,
    cx: &mut App,
) -> Box<dyn PageEngine> {
    #[cfg(feature = "cef")]
    match super::cef::CefEngine::start(sender.clone(), adapter, cx) {
        Ok(engine) => {
            // CEF's start-up replaces the signal handlers; Quit on SIGTERM needs them back.
            crate::lifecycle::terminate::listen(cx);
            return Box::new(engine);
        }
        Err(error) => eprintln!("CEF unavailable: {error}"),
    }
    let _ = (adapter, cx);
    Box::new(PlaceholderEngine::new(sender))
}
