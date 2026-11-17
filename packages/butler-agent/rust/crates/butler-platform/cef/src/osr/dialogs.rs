#![allow(clippy::transmute_ptr_to_ptr, reason = "cef-rs wrap macros")]
use super::{
    OsrAnswer, OsrDialog, OsrDialogKind, OsrEvent, OsrRuntime,
    state::{Events, PageRef, Phase},
};
use cef::*;

pub(super) enum Callback {
    Js(JsdialogCallback),
    Auth(AuthCallback),
    File(FileDialogCallback),
}
impl Callback {
    fn answer(self, answer: OsrAnswer) {
        match self {
            Self::Js(callback) => {
                callback.cont(i32::from(answer.accept), Some(&answer.text.as_str().into()));
            }
            Self::Auth(callback) if answer.accept => callback.cont(
                Some(&answer.username.as_str().into()),
                Some(&answer.password.as_str().into()),
            ),
            Self::Auth(callback) => callback.cancel(),
            Self::File(callback) if answer.accept => {
                let mut paths = CefStringList::new();
                for path in answer.files {
                    paths.append(path.to_string_lossy().as_ref());
                }
                callback.cont(Some(&mut paths));
            }
            Self::File(callback) => callback.cancel(),
        }
    }
}
impl OsrRuntime {
    pub fn answer_dialog(&self, page: u64, id: u64, answer: OsrAnswer) {
        let pending = self.page(page).and_then(|page| {
            let mut page = page.borrow_mut();
            if page
                .dialog
                .as_ref()
                .is_some_and(|(pending, _)| *pending == id)
            {
                page.dialog.take()
            } else {
                None
            }
        });
        if let Some((_, callback)) = pending {
            callback.answer(answer);
        }
    }
    pub fn cancel_dialogs(&self, page: u64) {
        let pending = self
            .page(page)
            .and_then(|page| page.borrow_mut().dialog.take());
        if let Some((_, callback)) = pending {
            callback.answer(OsrAnswer::default());
        }
    }
}
pub(super) fn begin(shared: &PageRef, events: &Events, mut dialog: OsrDialog, callback: Callback) {
    let mut page = shared.borrow_mut();
    if page.phase == Phase::Closing || page.dialog.is_some() {
        drop(page);
        callback.answer(OsrAnswer::default());
        return;
    }
    page.next_dialog += 1;
    dialog.id = page.next_dialog;
    page.dialog = Some((dialog.id, callback));
    drop(page);
    events.emit(OsrEvent::Dialog(dialog));
}
fn dialog(kind: OsrDialogKind, message: Option<&CefString>, origin: String) -> OsrDialog {
    OsrDialog {
        id: 0,
        kind,
        message: message.map(ToString::to_string).unwrap_or_default(),
        default_prompt: String::new(),
        origin,
        accept_types: Vec::new(),
        multiple: false,
    }
}
fn origin(browser: Option<&mut Browser>) -> String {
    browser
        .and_then(|b| b.main_frame())
        .map(|f| CefString::from(&f.url()).to_string())
        .unwrap_or_default()
}
cef::wrap_jsdialog_handler! {
    pub(super) struct Js { shared: PageRef, events: Events }
    impl JsdialogHandler {
        fn on_jsdialog(&self, _browser: Option<&mut Browser>, url: Option<&CefString>, kind: JsdialogType,
            message: Option<&CefString>, prompt: Option<&CefString>, callback: Option<&mut JsdialogCallback>,
            _suppress: Option<&mut i32>) -> i32 {
            let Some(callback) = callback else { return 0; };
            let kind = if kind == JsdialogType::PROMPT { OsrDialogKind::Prompt }
                else if kind == JsdialogType::CONFIRM { OsrDialogKind::Confirm } else { OsrDialogKind::Alert };
            let mut value = dialog(kind, message, url.map(ToString::to_string).unwrap_or_default());
            value.default_prompt = prompt.map(ToString::to_string).unwrap_or_default();
            begin(&self.shared, &self.events, value, Callback::Js(callback.clone()));
            1
        }
        fn on_before_unload_dialog(&self, browser: Option<&mut Browser>, message: Option<&CefString>,
            _reload: i32, callback: Option<&mut JsdialogCallback>) -> i32 {
            let Some(callback) = callback else { return 0; };
            begin(&self.shared, &self.events, dialog(OsrDialogKind::BeforeUnload, message, origin(browser)), Callback::Js(callback.clone()));
            1
        }
    }
}
cef::wrap_dialog_handler! {
    pub(super) struct Files { shared: PageRef, events: Events }
    impl DialogHandler {
        fn on_file_dialog(&self, browser: Option<&mut Browser>, mode: FileDialogMode, title: Option<&CefString>,
            _path: Option<&CefString>, filters: Option<&mut CefStringList>, extensions: Option<&mut CefStringList>,
            _descriptions: Option<&mut CefStringList>, callback: Option<&mut FileDialogCallback>) -> i32 {
            let Some(callback) = callback else { return 0; };
            let mut value = dialog(OsrDialogKind::File, title, origin(browser));
            value.accept_types = filters.map(|f| f.clone().into_iter().collect()).unwrap_or_default();
            if let Some(extensions) = extensions { value.accept_types.extend(extensions.clone()); }
            value.multiple = mode == FileDialogMode::OPEN_MULTIPLE;
            begin(&self.shared, &self.events, value, Callback::File(callback.clone()));
            1
        }
    }
}

// CEF asks for HTTP credentials on its IO thread. Only owned data and CEF's
// thread-safe callback cross back to the UI thread.
pub(super) struct AuthRequest {
    pub(super) page: u64,
    pub(super) callback: AuthCallback,
    pub(super) origin: String,
    pub(super) realm: String,
}
#[derive(Clone)]
pub(super) struct AuthSender {
    pub(super) sender: std::sync::mpsc::Sender<AuthRequest>,
    pub(super) schedule: super::PumpScheduler,
}
impl AuthSender {
    pub(super) fn send(&self, request: AuthRequest) {
        if let Err(error) = self.sender.send(request) {
            error.0.callback.cancel();
        }
        (self.schedule)(std::time::Duration::ZERO);
    }
}
impl OsrRuntime {
    pub(super) fn receive_auth(&self) {
        while let Ok(request) = self.auth_requests.try_recv() {
            let Some(shared) = self.page(request.page) else {
                request.callback.cancel();
                continue;
            };
            let value = OsrDialog {
                message: request.realm,
                ..dialog(OsrDialogKind::Auth, None, request.origin)
            };
            begin(
                &shared,
                &Events {
                    page: request.page,
                    sink: self.sink.clone(),
                },
                value,
                Callback::Auth(request.callback),
            );
        }
    }
}
