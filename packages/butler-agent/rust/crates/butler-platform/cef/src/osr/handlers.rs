#![allow(clippy::transmute_ptr_to_ptr, reason = "cef-rs wrap macros")]
use super::{
    OsrCursor, OsrEvent, RuntimeState,
    paint::Paint,
    state::{Events, PageRef},
};
use cef::*;
use std::rc::Weak;

pub(super) fn client(shared: PageRef, events: Events, runtime: Weak<RuntimeState>) -> Client {
    OsrClient::new(
        Paint::new(shared.clone(), events.clone()),
        Life::new(shared, events.clone(), runtime),
        Display::new(events.clone()),
        Load::new(events.clone()),
        Request::new(events),
    )
}

cef::wrap_client! {
    pub(super) struct OsrClient {
        paint: RenderHandler, life: LifeSpanHandler, display: DisplayHandler,
        load: LoadHandler, request: RequestHandler,
    }
    impl Client {
        fn render_handler(&self) -> Option<RenderHandler> { Some(self.paint.clone()) }
        fn life_span_handler(&self) -> Option<LifeSpanHandler> { Some(self.life.clone()) }
        fn display_handler(&self) -> Option<DisplayHandler> { Some(self.display.clone()) }
        fn load_handler(&self) -> Option<LoadHandler> { Some(self.load.clone()) }
        fn request_handler(&self) -> Option<RequestHandler> { Some(self.request.clone()) }
    }
}
cef::wrap_life_span_handler! {
    pub(super) struct Life { shared: PageRef, events: Events, runtime: Weak<RuntimeState> }
    impl LifeSpanHandler {
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
            }
        }
        fn on_before_popup(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>,
            _id: i32, _url: Option<&CefString>, _name: Option<&CefString>,
            _disposition: WindowOpenDisposition, _gesture: i32, _features: Option<&PopupFeatures>,
            _info: Option<&mut WindowInfo>, _client: Option<&mut Option<Client>>,
            _settings: Option<&mut BrowserSettings>, _extra: Option<&mut Option<DictionaryValue>>,
            _access: Option<&mut i32>) -> i32 { 1 }
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
        fn on_cursor_change(&self, _browser: Option<&mut Browser>, _cursor: *mut u8,
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
    pub(super) struct Request { events: Events }
    impl RequestHandler {
        fn on_render_process_terminated(&self, _browser: Option<&mut Browser>, _status: TerminationStatus,
            _code: i32, _message: Option<&CefString>) { self.events.emit(OsrEvent::Crashed); }
    }
}
