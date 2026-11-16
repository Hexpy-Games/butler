#![allow(clippy::transmute_ptr_to_ptr, reason = "cef-rs wrap macros")]
use super::{
    OsrCursor, OsrEvent, RuntimeState,
    paint::Paint,
    state::{Events, PageRef},
};
use cef::*;
use std::rc::Weak;

#[cfg(target_os = "macos")]
type NativeCursor = *mut u8;
#[cfg(any(windows, target_os = "linux"))]
type NativeCursor = CursorHandle;

pub(super) fn client(shared: PageRef, events: Events, runtime: &Weak<RuntimeState>) -> Client {
    OsrClient::new(
        Paint::new(shared.clone(), events.clone()),
        Life::new(shared.clone(), events.clone(), runtime.clone()),
        Display::new(events.clone()),
        Load::new(events.clone()),
        Request::new(events.clone(), runtime.upgrade().map(|r| r.auth.clone())),
        PageDialogs {
            js: super::dialogs::Js::new(shared.clone(), events.clone()),
            files: super::dialogs::Files::new(shared, events.clone()),
        },
        super::downloads::Downloads::new(events, runtime.clone()),
    )
}

#[derive(Clone)]
pub(super) struct PageDialogs {
    js: JsdialogHandler,
    files: DialogHandler,
}

cef::wrap_client! {
    pub(super) struct OsrClient {
        paint: RenderHandler, life: LifeSpanHandler, display: DisplayHandler,
        load: LoadHandler, request: RequestHandler, dialogs: PageDialogs, downloads: DownloadHandler,
    }
    impl Client {
        fn download_handler(&self) -> Option<DownloadHandler> { Some(self.downloads.clone()) }
        fn render_handler(&self) -> Option<RenderHandler> { Some(self.paint.clone()) }
        fn life_span_handler(&self) -> Option<LifeSpanHandler> { Some(self.life.clone()) }
        fn display_handler(&self) -> Option<DisplayHandler> { Some(self.display.clone()) }
        fn load_handler(&self) -> Option<LoadHandler> { Some(self.load.clone()) }
        fn jsdialog_handler(&self) -> Option<JsdialogHandler> { Some(self.dialogs.js.clone()) }
        fn dialog_handler(&self) -> Option<DialogHandler> { Some(self.dialogs.files.clone()) }
        fn request_handler(&self) -> Option<RequestHandler> { Some(self.request.clone()) }
    }
}
cef::wrap_life_span_handler! {
    pub(super) struct Life { shared: PageRef, events: Events, runtime: Weak<RuntimeState> }
    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            self.shared.borrow_mut().browser = browser.cloned();
        }
        fn do_close(&self, _browser: Option<&mut Browser>) -> i32 {
            if !self.shared.borrow().closing { self.events.emit(OsrEvent::CloseRequested); }
            0
        }
        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            let visible = {
                let mut p = self.shared.borrow_mut();
                p.release_frames();
                p.browser = None;
                let visible = p.visible;
                p.visible = false;
                visible
            };
            if let Some(runtime) = self.runtime.upgrade() {
                if visible { runtime.visible.set(runtime.visible.get() - 1); }
                runtime.pages.borrow_mut().remove(&self.events.page);
                if let Some(owner) = &self.shared.borrow().signed_out_owner {
                    let mut contexts = runtime.contexts.borrow_mut();
                    if let Some((_, count)) = contexts.get_mut(owner) {
                        *count -= 1;
                        if *count == 0 { contexts.remove(owner); }
                    }
                }
            }
        }
        fn on_before_popup(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>,
            _id: i32, url: Option<&CefString>, _name: Option<&CefString>,
            disposition: WindowOpenDisposition, gesture: i32, _features: Option<&PopupFeatures>,
            info: Option<&mut WindowInfo>, client: Option<&mut Option<Client>>,
            _settings: Option<&mut BrowserSettings>, _extra: Option<&mut Option<DictionaryValue>>,
            _access: Option<&mut i32>) -> i32 {
            super::popups::before(&self.shared, &self.events, &self.runtime, url, disposition, gesture, info, client)
        }
    }
}
cef::wrap_display_handler! {
    pub(super) struct Display { events: Events }
    impl DisplayHandler {
        fn on_address_change(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, url: Option<&CefString>) {
            if frame.is_some_and(|f| f.is_main() != 0) {
                self.events.emit(OsrEvent::Url(url.map(ToString::to_string).unwrap_or_default()));
            }
        }
        fn on_title_change(&self, _browser: Option<&mut Browser>, title: Option<&CefString>) {
            self.events.emit(OsrEvent::Title(title.map(ToString::to_string).unwrap_or_default()));
        }
        fn on_favicon_urlchange(&self, _browser: Option<&mut Browser>, urls: Option<&mut CefStringList>) {
            if let Some(urls) = urls {
                for url in urls.clone() { self.events.emit(OsrEvent::Favicon(url)); }
            }
        }
        fn on_cursor_change(&self, _browser: Option<&mut Browser>, _cursor: NativeCursor,
            kind: CursorType, _custom: Option<&CursorInfo>) -> i32 {
            let cursor = if kind == CursorType::HAND { OsrCursor::PointingHand }
                else if kind == CursorType::IBEAM { OsrCursor::IBeam } else { OsrCursor::Arrow };
            self.events.emit(OsrEvent::Cursor(cursor));
            1
        }
    }
}
cef::wrap_load_handler! {
    pub(super) struct Load { events: Events }
    impl LoadHandler {
        fn on_loading_state_change(&self, _browser: Option<&mut Browser>, loading: i32, back: i32, forward: i32) {
            self.events.emit(OsrEvent::Loading(loading != 0));
            self.events.emit(OsrEvent::History { can_back: back != 0, can_forward: forward != 0 });
        }
    }
}
cef::wrap_request_handler! {
    pub(super) struct Request { events: Events, auth: Option<super::dialogs::AuthSender> }
    impl RequestHandler {
        fn auth_credentials(&self, _browser: Option<&mut Browser>, url: Option<&CefString>,
            proxy: i32, _host: Option<&CefString>, _port: i32, realm: Option<&CefString>,
            _scheme: Option<&CefString>, callback: Option<&mut AuthCallback>) -> i32 {
            let (Some(auth), Some(callback)) = (&self.auth, callback) else { return 0; };
            if proxy != 0 { callback.cancel(); return 1; }
            auth.send(super::dialogs::AuthRequest {
                page: self.events.page, callback: callback.clone(),
                origin: url.map(ToString::to_string).unwrap_or_default(),
                realm: realm.map(ToString::to_string).unwrap_or_default(),
            });
            1
        }
        fn on_render_process_terminated(&self, _browser: Option<&mut Browser>, _status: TerminationStatus,
            _code: i32, _message: Option<&CefString>) { self.events.emit(OsrEvent::Crashed); }
    }
}
