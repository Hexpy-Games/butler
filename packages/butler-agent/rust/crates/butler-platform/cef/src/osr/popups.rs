use super::{
    OsrEvent, PopupDecision, PopupDisposition, PopupRequest, RuntimeState,
    state::{Events, Page, PageRef},
};
use cef::{CefString, Client, WindowInfo, WindowOpenDisposition};
use std::{
    cell::RefCell,
    rc::{Rc, Weak},
};

#[expect(
    clippy::too_many_arguments,
    reason = "CEF's synchronous popup callback"
)]
pub(super) fn before(
    opener: &PageRef,
    events: &Events,
    runtime: &Weak<RuntimeState>,
    url: Option<&CefString>,
    disposition: WindowOpenDisposition,
    gesture: i32,
    info: Option<&mut WindowInfo>,
    client: Option<&mut Option<Client>>,
) -> i32 {
    let Some(runtime) = runtime.upgrade() else {
        return 1;
    };
    let url = url.map(ToString::to_string).unwrap_or_default();
    let disposition = if disposition == WindowOpenDisposition::NEW_FOREGROUND_TAB
        || disposition == WindowOpenDisposition::NEW_BACKGROUND_TAB
    {
        PopupDisposition::NewTab
    } else if disposition == WindowOpenDisposition::NEW_WINDOW {
        PopupDisposition::NewWindow
    } else if disposition == WindowOpenDisposition::NEW_POPUP {
        PopupDisposition::NewPopup
    } else {
        PopupDisposition::Other
    };
    match (runtime.popups)(&PopupRequest {
        opener: events.page,
        url: url.clone(),
        disposition,
        user_gesture: gesture != 0,
    }) {
        PopupDecision::NewTab => {
            events.emit(OsrEvent::PopupNewTab { url });
            1
        }
        PopupDecision::Block(reason) => {
            events.emit(OsrEvent::PopupBlocked { url, reason });
            1
        }
        PopupDecision::Allow { child } => {
            let (Some(info), Some(client)) = (info, client) else {
                return 1;
            };
            allow(opener, events, &runtime, child, info, client);
            events.emit(OsrEvent::PopupOpened { child, url });
            0
        }
    }
}

fn allow(
    opener: &PageRef,
    events: &Events,
    runtime: &Rc<RuntimeState>,
    child: u64,
    info: &mut WindowInfo,
    client: &mut Option<Client>,
) {
    let source = opener.borrow();
    let mut page = Page::new(source.size, source.scale);
    page.signed_out_owner = source.signed_out_owner.clone();
    if let Some(owner) = &page.signed_out_owner
        && let Some((_, count)) = runtime.contexts.borrow_mut().get_mut(owner)
    {
        *count += 1;
    }
    drop(source);
    let shared = Rc::new(RefCell::new(page));
    *info = WindowInfo {
        windowless_rendering_enabled: 1,
        // Linux paints in software through `on_paint`.
        shared_texture_enabled: i32::from(cfg!(not(target_os = "linux"))),
        ..Default::default()
    };
    *client = Some(super::handlers::client(
        shared.clone(),
        Events {
            page: child,
            sink: events.sink.clone(),
        },
        &Rc::downgrade(runtime),
    ));
    runtime.pages.borrow_mut().insert(child, shared);
    runtime.visible.set(runtime.visible.get() + 1);
}
