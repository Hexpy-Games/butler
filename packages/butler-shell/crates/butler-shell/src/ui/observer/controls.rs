//! `SessionObserverControls`: stop a running steward, or resume an interrupted one.
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dialog::DialogFooter;
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use gpui::ParentElement as _;
use gpui::{Context, SharedString};
use serde_json::{Value, json};

use super::SessionObserver;
use super::copy::words;
use crate::ui::source::fetch::fetch;
use crate::ui::source::wire::SessionView;

/// Which of the two steward calls a button makes.
#[derive(Clone, Copy)]
enum Call {
    Cancel,
    Resume,
}

impl SessionObserver {
    /// The footer for the shown view; `None` when the session cannot be stopped or resumed.
    pub(super) fn controls(&self, view: &SessionView, cx: &Context<Self>) -> Option<DialogFooter> {
        let relation = view.relation.as_ref()?;
        let copy = words(Ds::get(cx).lang());
        let me = cx.entity();
        let id: SharedString = relation.relation_id.clone().into();
        let retryable = view.latest_turn.as_ref().is_some_and(|turn| turn.retryable);
        let live = view.active_turn.is_some();
        let (call, busy, label, variant) = if retryable && !live {
            let label = if self.resuming {
                copy.retrying
            } else {
                copy.resume
            };
            (Call::Resume, self.resuming, label, Variant::Default)
        } else if live || view.waiting_for_children == Some(true) {
            let label = if self.cancelling {
                copy.cancelling
            } else {
                copy.stop
            };
            (Call::Cancel, self.cancelling, label, Variant::Destructive)
        } else {
            return None;
        };
        let mut button = Button::new("steward-observer-control")
            .variant(variant)
            .size(Size::Default)
            .text(label)
            .on_click(move |_, _, cx| {
                let id = id.clone();
                me.update(cx, |this, cx| this.steward(call, id, cx));
            });
        if busy {
            button = button.disabled();
        }
        Some(DialogFooter::new().child(button))
    }

    /// `cancelObservedSteward` / `resumeObservedSteward`: POST /steward-relations/{id}/…, then
    /// read the observed session again.
    /// The parent is the open conversation (`activeChatId`), not the relation's own parent; with
    /// no server-backed one, or no relation id, nothing is sent.
    fn steward(&mut self, call: Call, id: SharedString, cx: &mut Context<Self>) {
        let Some(parent) = self.parent.as_ref().map(ToString::to_string) else {
            return;
        };
        if id.trim().is_empty() {
            return;
        }
        match call {
            Call::Cancel => self.cancelling = true,
            Call::Resume => self.resuming = true,
        }
        cx.notify();
        let body = json!({ "parent_session_id": parent });
        fetch(
            cx,
            move |client| async move {
                match call {
                    Call::Cancel => client.cancel_steward(&id, &body).await,
                    Call::Resume => client.resume_steward(&id, &body).await,
                }
            },
            move |this: &mut Self, result: Result<Value, Error>, cx| {
                this.cancelling = false;
                this.resuming = false;
                match result {
                    Ok(_) => this.refresh(cx),
                    Err(_) => {
                        let copy = words(Ds::get(cx).lang());
                        let message = match call {
                            Call::Cancel => copy.stop_failed,
                            Call::Resume => copy.resume_failed,
                        };
                        toast::show(cx, Toast::error(message));
                    }
                }
            },
        );
    }
}
