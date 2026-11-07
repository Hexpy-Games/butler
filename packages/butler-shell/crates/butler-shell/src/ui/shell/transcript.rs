//! What the transcript asks of the shell: older messages, sending, the queue, settings and
//! opening a session; and the open chat's view shown in it.
use std::rc::Rc;

use gpui::{App, BorrowAppContext as _, Context};

use super::{Shell, navigation::Navigation};
use crate::ui::chat::{self, AssistantHooks, OlderRequest};
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::SessionQueueView;

impl Shell {
    /// Registers what the transcript asks of the shell: older messages, sending, the queue and
    /// opening a session.
    pub(super) fn transcript_hooks(cx: &mut Context<Self>) {
        let shell = cx.weak_entity();
        let older = shell.clone();
        chat::on_load_older(cx, move |request, cx| {
            let older = older.clone();
            cx.defer(move |cx| {
                let _ = older.update(cx, |this, cx| this.load_older(&request, cx));
            });
        });
        let send = shell.clone();
        chat::on_send(cx, move |text, cx| {
            let text = text.to_owned();
            let _ = send.update(cx, |this, cx| this.send(text, cx));
        });
        let queue = shell.clone();
        chat::on_queue_changed(cx, move |cx| {
            let _ = queue.update(cx, super::Shell::reload_queue);
        });
        let open = shell;
        cx.set_global(AssistantHooks {
            developer_mode: false,
            open_session: Some(Rc::new(move |id: &str, cx: &mut App| {
                let id = id.to_owned();
                let _ = open.update(cx, |this, cx| {
                    this.pending_navigation = Some(Navigation::Session(id));
                    cx.notify();
                });
            })),
            open_trace: None,
        });
    }

    /// The settings the transcript reads: the chats intro flag and developer mode.
    pub(super) fn load_settings(cx: &mut Context<Self>) {
        let request = Jobs::run(cx, |client| async move { client.get_settings().await });
        cx.spawn(async move |this, cx| {
            let Some(Ok(raw)) = request.await else {
                return;
            };
            let flag = |key: &str| raw.get(key).and_then(serde_json::Value::as_bool);
            let (seen, developer) = (flag("chats_intro_seen"), flag("diagnostics_enabled"));
            let _ = this.update(cx, |_, cx| {
                if let Some(seen) = seen {
                    chat::set_chats_intro_seen(cx, seen);
                }
                cx.update_global(|hooks: &mut AssistantHooks, _| {
                    hooks.developer_mode = developer == Some(true);
                });
                cx.notify();
            });
        })
        .detach();
    }

    /// Reloads the open chat's queued follow-ups.
    pub(super) fn reload_queue(&mut self, cx: &mut Context<Self>) {
        let Some(chat) = self.store.selected().cloned() else {
            return;
        };
        let session = chat.session.0.to_string();
        let request = Jobs::run(cx, move |client| async move {
            client.list_session_queue(&session).await
        });
        cx.spawn(async move |this, cx| {
            let Some(Ok(raw)) = request.await else {
                return;
            };
            let queue = serde_json::from_value::<SessionQueueView>(raw).ok();
            let _ = this.update(cx, |this, cx| {
                if this.store.selected() != Some(&chat) {
                    return;
                }
                let pending = queue.as_ref().map(|view| view.queued_messages.clone());
                this.composer
                    .update(cx, |c, _| c.set_queue(pending.unwrap_or_default()));
                this.chat.update(cx, |c, cx| {
                    c.set_queue(queue.map(Rc::new));
                    cx.notify();
                });
                cx.notify();
            });
        })
        .detach();
    }

    /// Shows the open chat's view (with the turns' live progress) in the transcript.
    pub(crate) fn show_view(&mut self, live: bool, cx: &mut Context<Self>) {
        let view = self.store.shown_view().map(Rc::new);
        let decision_view = view.clone();
        self.feed_panes(view.clone(), cx);
        self.composer.update(cx, |c, cx| {
            c.set_decision_view(decision_view);
            cx.notify();
        });
        self.chat.update(cx, |c, cx| {
            c.set_view(view, live, cx);
            cx.notify();
        });
    }

    /// Reads the open chat's latest window again and merges it into the shown view.
    pub(super) fn refresh_open_view(&mut self, cx: &mut Context<Self>) {
        if self.refresh != super::Refresh::Idle {
            self.refresh = super::Refresh::Again;
            return;
        }
        let (Some(chat), Some(source)) = (self.store.selected().cloned(), self.source.clone())
        else {
            return;
        };
        self.refresh = super::Refresh::Running;
        let shown = chat.clone();
        Self::run(
            source.session_view(&chat.session, None),
            cx,
            move |this, result, cx| {
                let again = this.refresh == super::Refresh::Again;
                this.refresh = super::Refresh::Idle;
                if again {
                    this.refresh_open_view(cx);
                }
                match result {
                    Ok(view) => {
                        if this.store.view_refreshed(&shown, view) {
                            this.show_view(true, cx);
                            this.reload_queue(cx);
                        }
                        this.sync_composer(cx);
                    }
                    Err(e) => this.chat_failed(&shown, &e, this.theme.strings.load_failed, cx),
                }
            },
        );
    }

    /// The window before the shown one, from the cursor token the transcript asked with.
    pub(super) fn load_older(&mut self, request: &OlderRequest, cx: &mut Context<Self>) {
        let (Some(source), Some(chat), Some(token)) = (
            self.source.clone(),
            self.store.selected().cloned(),
            request.before_cursor_token.clone(),
        ) else {
            return;
        };
        if chat.session.0.as_ref() != request.session_id {
            return;
        }
        Self::run(
            source.session_view(&chat.session, Some(token)),
            cx,
            move |this, result, cx| match result {
                Ok(older) => {
                    if this.store.older_loaded(&chat, older) {
                        this.show_view(false, cx);
                    }
                }
                Err(e) => this.chat_failed(&chat, &e, this.theme.strings.load_failed, cx),
            },
        );
    }
}
