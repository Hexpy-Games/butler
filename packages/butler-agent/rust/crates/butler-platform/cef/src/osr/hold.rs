//! A page created with its loads held: no request of it reaches the network or disk until
//! `release_loads`. Navigations stop in `on_before_browse` (UI thread, every frame); every other
//! request stops in `on_before_resource_load` (IO thread), so the state is shared across threads.
#![allow(clippy::transmute_ptr_to_ptr, reason = "cef-rs wrap macros")]
use super::OsrRuntime;
use cef::*;
use std::sync::{Arc, Mutex, PoisonError};

/// `None` once the page may load; while held, the URL its main frame last tried to load.
#[derive(Clone, Default)]
pub(super) struct Loads(Arc<Mutex<Option<Option<String>>>>);

impl Loads {
    pub(super) fn held() -> Self {
        Self(Arc::new(Mutex::new(Some(None))))
    }

    fn hold(&self) -> std::sync::MutexGuard<'_, Option<Option<String>>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether a load of `url` is cancelled. Only `about:blank` and `about:srcdoc` pass: they
    /// need no request. A main-frame navigation is kept when cancelled, the last one winning as
    /// the browser would end on it (a passing `about:blank` leaves nothing kept).
    fn cancels(&self, url: &str, main_frame: bool) -> bool {
        let mut hold = self.hold();
        let Some(kept) = hold.as_mut() else {
            return false;
        };
        let base = url.split(['?', '#']).next().unwrap_or_default();
        let cancel = !matches!(base, "about:blank" | "about:srcdoc");
        if main_frame {
            *kept = cancel.then(|| url.to_owned());
        }
        cancel
    }

    /// The navigation `request` of `frame` is cancelled.
    pub(super) fn cancels_navigation(
        &self,
        frame: Option<&mut Frame>,
        request: Option<&mut Request>,
    ) -> bool {
        let url = request.map(|r| CefString::from(&r.url()).to_string());
        self.cancels(
            &url.unwrap_or_default(),
            frame.is_some_and(|f| f.is_main() != 0),
        )
    }

    /// While held, the handler that cancels every request it is asked about.
    pub(super) fn handler(
        &self,
        frame: Option<&mut Frame>,
        is_navigation: i32,
    ) -> Option<ResourceRequestHandler> {
        let held = self.hold().is_some();
        held.then(|| {
            let main_frame = is_navigation != 0 && frame.is_some_and(|f| f.is_main() != 0);
            Cancel::new(self.clone(), main_frame)
        })
    }
}

cef::wrap_resource_request_handler! {
    struct Cancel { loads: Loads, main_frame: bool }
    impl ResourceRequestHandler {
        fn on_before_resource_load(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>,
            request: Option<&mut Request>, _callback: Option<&mut Callback>) -> ReturnValue {
            let url = request.map(|r| CefString::from(&r.url()).to_string()).unwrap_or_default();
            if self.loads.cancels(&url, self.main_frame) { ReturnValue::CANCEL } else { ReturnValue::CONTINUE }
        }
    }
}

impl OsrRuntime {
    /// Lets a page held since its creation load; the URL its main frame last tried to load
    /// meanwhile, if any. A page not held is left as it is.
    pub fn release_loads(&self, page: u64) -> Option<String> {
        self.page(page)?.borrow().loads.hold().take().flatten()
    }

    /// The URL a held page's main frame last tried to load, if any.
    pub fn held_url(&self, page: u64) -> Option<String> {
        self.page(page)?.borrow().loads.hold().clone().flatten()
    }
}
