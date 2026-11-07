//! `FailureNotice` (+ `FailureNoticeContainer`), `MessageRetryActions` and `MessageTraceMenu`.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::blocks::overflow_action_menu::{OverflowActionMenu, OverflowItem};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Justify, Stack};
use gpui::{
    AnyElement, App, ClickEvent, IntoElement as _, ParentElement as _, SharedString, Window,
};

use super::copy::text;
use super::hooks::{hooks, retrying, set_retrying, trace_target};
use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::{MessageRecord, MessageRecordRetryMode};

type Click = dyn Fn(&ClickEvent, &mut Window, &mut App);

/// A retry of `turn_id` (the store's `retryTurn` / `retryTurnWithCurrentControls`): it marks the
/// turn as retrying until the call returns.
fn retry_click(t: &TranscriptCtx, turn_id: String, with_current_controls: bool) -> Box<Click> {
    let client = t.client.clone();
    Box::new(move |_, window, cx| {
        let Some(client) = client.clone() else {
            return;
        };
        set_retrying(Some(turn_id.clone()), cx);
        window.refresh();
        let turn = turn_id.clone();
        let done = super::remote::run(cx, async move {
            if with_current_controls {
                client.retry_turn_with_current_controls(&turn).await
            } else {
                client.retry_turn(&turn).await
            }
        });
        cx.spawn(async move |cx| {
            let _ = done.await;
            cx.update(|cx| {
                set_retrying(None, cx);
                cx.refresh_windows();
            });
        })
        .detach();
    })
}

/// `isRetryableFailureMessage`
pub(crate) fn retryable(message: &MessageRecord) -> bool {
    message.retryable == Some(true) && message.retry_mode.is_some()
}

/// `canRetryWithCurrentControls`
pub(crate) fn can_retry_with_current_controls(message: &MessageRecord) -> bool {
    message.retryable == Some(true) && message.retry_with_current_controls == Some(true)
}

/// The failure notice of an assistant message, with its retry and log actions.
pub(super) fn failure_notice(
    message: &MessageRecord,
    t: &TranscriptCtx,
    cx: &mut App,
) -> AnyElement {
    let copy = text(cx);
    let reason = if message.text.trim().is_empty() {
        copy.fallback_reason.to_owned()
    } else {
        message.text.clone()
    };
    let busy = message
        .turn_id
        .as_deref()
        .is_some_and(|turn| retrying(turn, cx));
    let turn_id = message.turn_id.clone().filter(|_| retryable(message));
    let trace = hooks(cx)
        .developer_mode
        .then(|| trace_target(message))
        .flatten();
    let mut actions = button::container(Size::Sm).justify(Justify::End);
    let mut any = false;
    let label = |normal: &'static str| if busy { copy.retrying } else { normal };
    if let Some(turn) = turn_id {
        any = true;
        let resume = message.retry_mode == Some(MessageRecordRetryMode::Resume);
        let mut first = Button::new(SharedString::from(format!("retry-{}", message.id)))
            .size(Size::Sm)
            .variant(Variant::Outline)
            .text(label(copy.retry))
            .on_click(retry_click(t, turn.clone(), !resume));
        if busy {
            first = first.disabled();
        }
        actions = actions.child(first);
        if can_retry_with_current_controls(message) {
            let mut current =
                Button::new(SharedString::from(format!("retry-current-{}", message.id)))
                    .size(Size::Sm)
                    .variant(Variant::Outline)
                    .text(label(copy.retry_current))
                    .on_click(retry_click(t, turn, true));
            if busy {
                current = current.disabled();
            }
            actions = actions.child(current);
        }
    }
    if let Some(trace) = trace {
        any = true;
        let open = hooks(cx).open_trace;
        actions = actions.child(
            Button::new(SharedString::from(format!(
                "failure-view-logs-{}",
                message.id
            )))
            .size(Size::Sm)
            .variant(Variant::Outline)
            .text(copy.view_logs)
            .on_click(move |_, _, cx| {
                if let Some(open) = &open {
                    open(&trace, cx);
                }
            }),
        );
    }
    let mut notice = Notice::new(NoticeTone::Error, reason)
        .icon(icon(Icon::AlertCircle, IconSize::Md, Ds::get(cx)))
        .title(copy.failure_title);
    if any {
        notice = notice.action(actions);
    }
    notice.into_any_element()
}

/// `MessageRetryActions`: Retry, and Retry with current settings next to it.
pub(crate) fn message_retry_actions(
    turn_id: &str,
    with_current_controls: bool,
    t: &TranscriptCtx,
    cx: &App,
) -> AnyElement {
    let copy = text(cx);
    let busy = retrying(turn_id, cx);
    let label = |normal: &'static str| if busy { copy.retrying } else { normal };
    let mut first = Button::new(SharedString::from(format!("message-retry-{turn_id}")))
        .variant(Variant::Outline)
        .text(label(copy.retry))
        .on_click(retry_click(t, turn_id.to_owned(), false));
    if busy {
        first = first.disabled();
    }
    let mut row = Stack::row()
        .cross(Cross::Center)
        .justify(Justify::End)
        .child(first);
    if with_current_controls {
        let mut current = Button::new(SharedString::from(format!(
            "message-retry-current-{turn_id}"
        )))
        .variant(Variant::Outline)
        .text(label(copy.retry_current))
        .on_click(retry_click(t, turn_id.to_owned(), true));
        if busy {
            current = current.disabled();
        }
        row = row.child(current);
    }
    row.into_any_element()
}

/// `MessageTraceMenu`: developer mode, the answer's overflow menu with the log view for its trace.
pub(crate) fn message_trace_menu(message: &MessageRecord, cx: &App) -> Option<AnyElement> {
    let hooks = hooks(cx);
    let trace = hooks
        .developer_mode
        .then(|| trace_target(message))
        .flatten()?;
    let copy = text(cx);
    let open = hooks.open_trace;
    Some(
        OverflowActionMenu::new(
            SharedString::from(format!("trace-menu-{}", message.id)),
            copy.more,
        )
        .item(
            OverflowItem::new(copy.view_logs)
                .icon(Icon::Terminal)
                .on_select(move |_, cx| {
                    if let Some(open) = &open {
                        open(&trace, cx);
                    }
                }),
        )
        .into_any_element(),
    )
}
