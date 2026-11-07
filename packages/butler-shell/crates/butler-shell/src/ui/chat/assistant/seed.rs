//! `SessionBranchSeed`.
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::card::Card;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::Typo;
use butler_shell_client::ShellClient;
use gpui::{
    AnyElement, App, ClickEvent, ElementId, Entity, IntoElement as _, ParentElement as _,
    SharedString, Window,
};
use serde_json::json;

use super::copy::text;
use super::hooks::hooks;
use super::remote;
use crate::ui::chat::TranscriptCtx;
use crate::ui::chat::message_markdown::message_markdown;

/// The click that opens the branch's source session (`openBranchSource`: `POST
/// /space/branch-source`), showing the failure in `error`.
fn open_source_click(
    client: Option<ShellClient>,
    session_id: String,
    error: Entity<Option<String>>,
) -> impl Fn(&ClickEvent, &mut Window, &mut App) + use<> {
    move |_, _, cx| {
        let Some(client) = client.clone() else {
            return;
        };
        error.update(cx, |error, _| *error = None);
        let session_id = session_id.clone();
        let done = remote::run(async move {
            client
                .create_space_branch_source(&json!({ "sessionId": session_id }))
                .await
        });
        let error = error.clone();
        cx.spawn(async move |cx| {
            let result = done.await;
            cx.update(|cx| match result {
                Ok(Ok(source)) => {
                    let view = source["view"]["session_id"].as_str().map(str::to_owned);
                    if let (Some(view), Some(open)) = (view, hooks(cx).open_session) {
                        open(&view, cx);
                    }
                }
                Ok(Err(message)) => error.update(cx, |error, cx| {
                    *error = Some(message);
                    cx.notify();
                }),
                Err(_) => {
                    let message = text(cx).seed_failed.to_owned();
                    error.update(cx, |error, cx| {
                        *error = Some(message);
                        cx.notify();
                    });
                }
            });
        })
        .detach();
    }
}

/// `SessionBranchSeed`: the summary a branched session starts from, and a way back to the source.
#[allow(dead_code, reason = "called by the list unit above the first message")]
pub(crate) fn session_branch_seed(
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let seed = t.view.branch_seed.as_ref()?;
    let copy = text(cx);
    let id = SharedString::from(format!("session-branch-seed-{}", t.view.session_id));
    let error = window.use_keyed_state((ElementId::from(id.clone()), "error"), cx, |_, _| {
        None::<String>
    });
    let mut column = Stack::new()
        .gap(Space::Sm)
        .child(Typo::section_title(copy.seed_title))
        .child(message_markdown(
            ElementId::from(SharedString::from(format!(
                "seed-summary-{}",
                t.view.session_id
            ))),
            SharedString::from(seed.summary.clone()),
            false,
            cx,
        ))
        .child(Typo::caption(copy.seed_description))
        .child(
            Button::new(SharedString::from(format!(
                "seed-open-{}",
                t.view.session_id
            )))
            .size(Size::Sm)
            .variant(Variant::Inline)
            .text(copy.seed_open)
            .on_click(open_source_click(
                t.client.clone(),
                t.view.session_id.clone(),
                error.clone(),
            )),
        );
    if let Some(message) = error.read(cx).clone() {
        column = column.child(Typo::caption(message));
    }
    Some(Card::new(id).child(column).into_any_element())
}
