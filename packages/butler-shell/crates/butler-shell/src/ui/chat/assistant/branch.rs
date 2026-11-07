//! `AssistantBranchActions`, `BranchMessageActions`, `SessionBranchForm` and `SessionBranchSeed`.
use butler_ds::ui::Icon;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::dialog::{
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::text::{self, Input};
use butler_ds::ui::typo::Typo;
use butler_shell_client::ShellClient;
use gpui::{
    AnyElement, App, ClickEvent, ElementId, Entity, IntoElement as _, ParentElement as _,
    SharedString, Window, div,
};
use serde_json::{Value, json};

use super::copy::text as copy_text;
use super::hooks::hooks;
use super::remote;
use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::MessageRecord;

const BRANCHABLE_STATUSES: [&str; 3] = ["delivered", "completed", "sent"];
const TITLE_MAX: usize = 120;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Topic,
    Project,
}

/// Branch actions for a settled answer in `general` or a project session. From a project
/// session the new conversation stays in that project (`BranchProjectContext` is the view's).
#[allow(dead_code, reason = "called by the message footer of the row unit")]
pub(crate) fn assistant_branch_actions(
    message: &MessageRecord,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let session_id = message.chat_id.clone().unwrap_or_default();
    let project_id = t.view.project_id.clone();
    let settled = !message.text.trim().is_empty()
        && message
            .status
            .as_deref()
            .is_none_or(|status| status.is_empty() || BRANCHABLE_STATUSES.contains(&status));
    if !settled || (session_id != "general" && project_id.is_none()) {
        return None;
    }
    let source = Source {
        session_id,
        message_id: message.id.clone(),
        project_id,
        client: t.client.clone(),
    };
    Some(branch_message_actions(source, window, cx))
}

/// What the form branches from, and where the new conversation goes.
struct Source {
    session_id: String,
    message_id: String,
    project_id: Option<String>,
    client: Option<ShellClient>,
}

/// The keyed state of one message's branch dialog.
struct FormState {
    mode: Entity<Option<Mode>>,
    pending: Entity<bool>,
    error: Entity<Option<String>>,
    /// The reservation: a retry after a failure reuses the request id.
    request: Entity<Option<String>>,
    /// Counts the openings; the title field's id carries it, so each opening starts empty.
    serial: Entity<u64>,
}

impl FormState {
    fn new(key: &ElementId, window: &mut Window, cx: &mut App) -> Self {
        Self {
            mode: window.use_keyed_state((key.clone(), "mode"), cx, |_, _| None::<Mode>),
            pending: window.use_keyed_state((key.clone(), "pending"), cx, |_, _| false),
            error: window.use_keyed_state((key.clone(), "error"), cx, |_, _| None::<String>),
            request: window.use_keyed_state((key.clone(), "request"), cx, |_, _| None::<String>),
            serial: window.use_keyed_state((key.clone(), "serial"), cx, |_, _| 0_u64),
        }
    }

    /// The click that opens the dialog in `next`, with an empty form.
    fn open_in(&self, next: Mode) -> impl Fn(&ClickEvent, &mut Window, &mut App) + use<> {
        let (mode, serial, error, request) = (
            self.mode.clone(),
            self.serial.clone(),
            self.error.clone(),
            self.request.clone(),
        );
        move |_, _, cx| {
            error.update(cx, |error, _| *error = None);
            request.update(cx, |request, _| *request = None);
            serial.update(cx, |serial, _| *serial += 1);
            mode.update(cx, |mode, cx| {
                *mode = Some(next);
                cx.notify();
            });
        }
    }
}

/// The two icon buttons and the dialog they open (`BranchMessageActions`).
fn branch_message_actions(source: Source, window: &mut Window, cx: &mut App) -> AnyElement {
    let copy = copy_text(cx);
    let key = ElementId::from(SharedString::from(format!("branch-{}", source.message_id)));
    let state = FormState::new(&key, window, cx);
    let buttons = div()
        .flex()
        .items_center()
        .child(
            IconButton::new(
                SharedString::from(format!("branch-chat-{}", source.message_id)),
                copy.branch_chat,
            )
            .glyph(Icon::MessageSquarePlus)
            .on_click(state.open_in(Mode::Topic)),
        )
        .child(
            IconButton::new(
                SharedString::from(format!("branch-project-{}", source.message_id)),
                copy.branch_project,
            )
            .glyph(Icon::FolderPlus)
            .on_click(state.open_in(Mode::Project)),
        );
    let current = *state.mode.read(cx);
    let dialog = {
        let (mode, pending) = (state.mode.clone(), state.pending.clone());
        Dialog::new(key, window, cx)
            .open(current.is_some())
            .on_open_change(move |open, _, cx| {
                if !open && !*pending.read(cx) {
                    mode.update(cx, |mode, cx| {
                        *mode = None;
                        cx.notify();
                    });
                }
            })
    };
    let content = match current {
        Some(current) => session_branch_form(&source, current, &state, &dialog, cx),
        None => DialogContent::new(),
    };
    let content = dialog.content(content, window, cx);
    div()
        .flex()
        .items_center()
        .child(buttons)
        .child(content)
        .into_any_element()
}

fn request_id(message_id: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!("{message_id}-{nanos}")
}

/// The create click: reserves a request id, posts the branch and reports the result.
fn create_click(
    source: &Source,
    project: bool,
    input_id: SharedString,
    state: &FormState,
) -> impl Fn(&ClickEvent, &mut Window, &mut App) + use<> {
    let (session_id, message_id) = (source.session_id.clone(), source.message_id.clone());
    let (project_id, client) = (source.project_id.clone(), source.client.clone());
    let (mode, pending, error, request) = (
        state.mode.clone(),
        state.pending.clone(),
        state.error.clone(),
        state.request.clone(),
    );
    move |_, window, cx| {
        let title: String = text::state(input_id.clone(), window, cx)
            .read(cx)
            .as_str()
            .trim()
            .chars()
            .take(TITLE_MAX)
            .collect();
        let Some(client) = client.clone() else {
            return;
        };
        if title.is_empty() || *pending.read(cx) {
            return;
        }
        let destination = if project {
            json!({ "kind": "new_project", "name": title })
        } else if let Some(project_id) = &project_id {
            json!({ "kind": "project", "projectId": project_id })
        } else {
            json!({ "kind": "chat" })
        };
        let reserved = request
            .read(cx)
            .clone()
            .unwrap_or_else(|| request_id(&message_id));
        request.update(cx, |request, _| *request = Some(reserved.clone()));
        let body = json!({
            "requestId": reserved,
            "sourceSessionId": session_id,
            "sourceMessageId": message_id,
            "title": title,
            "destination": destination,
        });
        pending.update(cx, |pending, cx| {
            *pending = true;
            cx.notify();
        });
        error.update(cx, |error, _| *error = None);
        let done = remote::run(async move { client.create_space_branches(&body).await });
        let (mode, pending, error) = (mode.clone(), pending.clone(), error.clone());
        cx.spawn(async move |cx| {
            let result = done.await;
            cx.update(|cx| finish_branch(result, &mode, &pending, &error, cx));
        })
        .detach();
    }
}

/// `SessionBranchForm`: a title, then create (a conversation or a project).
fn session_branch_form(
    source: &Source,
    mode: Mode,
    state: &FormState,
    dialog: &Dialog,
    cx: &mut App,
) -> DialogContent {
    let copy = copy_text(cx);
    let project = mode == Mode::Project;
    let input_id = SharedString::from(format!(
        "branch-title-{}-{}",
        source.message_id,
        *state.serial.read(cx)
    ));
    let pending = *state.pending.read(cx);
    let error = state.error.read(cx).clone();
    let mut input = Input::new(input_id.clone()).placeholder(if project {
        copy.project_name
    } else {
        copy.conversation_title
    });
    if state.request.read(cx).is_some() {
        input = input.disabled();
    }
    let mut close = Button::new("branch-close")
        .size(Size::Sm)
        .variant(Variant::Ghost)
        .text(copy.close)
        .on_click(dialog.closer().on_click());
    let mut create = Button::new("branch-create")
        .size(Size::Sm)
        .text(if error.is_some() {
            copy.try_again
        } else {
            copy.create
        })
        .on_click(create_click(source, project, input_id, state));
    if pending {
        close = close.disabled();
        create = create.disabled();
    }
    let mut content = DialogContent::new()
        .header(
            DialogHeader::new()
                .child(DialogTitle::new(if project {
                    copy.branch_project
                } else {
                    copy.branch_chat
                }))
                .child(DialogDescription::new(copy.branch_description)),
        )
        .child(input);
    if pending {
        content = content.child(Typo::body(copy.branch_pending));
    }
    if let Some(error) = error {
        content = content.child(Typo::body(error));
    }
    content.footer(DialogFooter::new().child(close).child(create))
}

type Created = Result<Result<Value, String>, futures::channel::oneshot::Canceled>;

/// The result of the create call: close and open the new session, or show the error.
fn finish_branch(
    result: Created,
    mode: &Entity<Option<Mode>>,
    pending: &Entity<bool>,
    error: &Entity<Option<String>>,
    cx: &mut App,
) {
    pending.update(cx, |pending, cx| {
        *pending = false;
        cx.notify();
    });
    match result {
        Ok(Ok(created)) => {
            mode.update(cx, |mode, cx| {
                *mode = None;
                cx.notify();
            });
            let session = created["session"]["id"].as_str().map(str::to_owned);
            if let (Some(session), Some(open)) = (session, hooks(cx).open_session) {
                open(&session, cx);
            }
        }
        Ok(Err(message)) => error.update(cx, |error, cx| {
            *error = Some(message);
            cx.notify();
        }),
        Err(_) => {
            let message = copy_text(cx).branch_failed.to_owned();
            error.update(cx, |error, cx| {
                *error = Some(message);
                cx.notify();
            });
        }
    }
}
