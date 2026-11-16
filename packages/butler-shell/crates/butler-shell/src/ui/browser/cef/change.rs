//! What a CEF page event means to the tab.
use super::surface::PageState;
use crate::ui::browser::{
    engine::PageChange,
    page_dialog::{DialogKind, EngineChild, PageDialog},
};
use butler_cef_host::osr::{OsrDialogKind, OsrEvent, PopupBlock};

pub(super) fn change(event: OsrEvent, state: &mut PageState) -> Option<PageChange> {
    Some(match event {
        OsrEvent::Url(url) => PageChange::Url(if url == "about:blank" {
            String::new()
        } else {
            url
        }),
        OsrEvent::Title(title) => PageChange::Title(title),
        OsrEvent::Favicon(url) => PageChange::Favicon(url),
        OsrEvent::Loading(loading) => PageChange::Loading(loading),
        OsrEvent::History {
            can_back,
            can_forward,
        } => PageChange::History {
            can_back,
            can_forward,
        },
        OsrEvent::PopupNewTab { url } => PageChange::PopupNewTab(url),
        OsrEvent::PopupBlocked { url, reason } => PageChange::PopupBlocked {
            url,
            reason: match reason {
                PopupBlock::NoGesture => "no_gesture",
                PopupBlock::TabBudget => "tab_budget_exhausted",
            },
        },
        OsrEvent::PopupOpened { child, url } => PageChange::PopupOpened {
            child: EngineChild(child),
            url,
        },
        OsrEvent::CloseRequested => PageChange::CloseRequested,
        OsrEvent::Dialog(dialog) => PageChange::Dialog(PageDialog {
            id: dialog.id,
            kind: match dialog.kind {
                OsrDialogKind::Alert => DialogKind::Alert,
                OsrDialogKind::Confirm => DialogKind::Confirm,
                OsrDialogKind::Prompt => DialogKind::Prompt,
                OsrDialogKind::BeforeUnload => DialogKind::BeforeUnload,
                OsrDialogKind::Auth => DialogKind::Auth,
                OsrDialogKind::File => DialogKind::File,
            },
            message: dialog.message,
            default_prompt: dialog.default_prompt,
            origin: dialog.origin,
            accept_types: dialog.accept_types,
            multiple: dialog.multiple,
        }),
        OsrEvent::DownloadStarted { .. }
        | OsrEvent::DownloadProgress { .. }
        | OsrEvent::DownloadDone { .. }
        | OsrEvent::Frame
        | OsrEvent::DevTools { .. } => return None,
        #[cfg(feature = "cef")]
        OsrEvent::DevToolsRaw { message } => PageChange::DevToolsRaw(message),
        OsrEvent::Crashed => PageChange::Crashed,
        OsrEvent::DevToolsEvent {
            method,
            params_json,
        } => PageChange::DevToolsEvent {
            method,
            params: serde_json::from_str(&params_json).unwrap_or_default(),
        },
        OsrEvent::Cursor(cursor) => {
            state.cursor = cursor;
            return None;
        }
        OsrEvent::ImeBounds(bounds) => {
            state.ime_bounds = bounds;
            return None;
        }
    })
}
