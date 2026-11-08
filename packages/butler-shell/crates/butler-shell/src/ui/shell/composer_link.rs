//! The shell's side of the composer: what it tells the composer about the open chat, what it
//! does with the composer's events, and the handlers the composer installs once.
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use gpui::{App, Context, Entity, Window};

use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use super::navigation::Navigation;
use super::{Shell, image_viewer};
use crate::ui::composer::queue::on_delete_queued;
use crate::ui::composer::{
    Composer, ComposerEvent, Inputs, Outgoing, clear_composer_text, composer_text, focus_composer,
};
use crate::ui::decisions;
use crate::ui::i18n::composer::words;
use crate::ui::inspector;
use crate::ui::source::agent::{Jobs, sent_turn, source_error};
use crate::ui::source::{ChatRef, Fetch, SentTurn, SourceError};

/// A message id unique to this process run (time plus a counter); sending twice with the same
/// id sends once.
fn client_message_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("shell-{nanos:x}-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

/// A navigation hook the decision panels and the task graph call with a session id.
type OpenHook = Rc<dyn Fn(&str, &mut App)>;

impl Shell {
    /// `sendMessage`: the draft goes into the open chat, or into a new one created first.
    pub(crate) fn send(&mut self, outgoing: impl Into<Outgoing>, cx: &mut Context<Self>) {
        let outgoing = outgoing.into();
        let Some(source) = self.source.clone() else {
            return;
        };
        if let Some(chat) = self.store.selected().cloned() {
            return Self::send_to(chat, &outgoing, false, cx);
        }
        Self::run(
            self.sidebar.new_chat_parent.as_ref().map_or_else(
                || source.create_chat(),
                |target| source.create_sidebar_chat(target.body()),
            ),
            cx,
            move |this, result, cx| match result {
                Ok(chat) => {
                    this.store.open(Some(chat.clone()));
                    this.show_view(false, cx);
                    this.reload_open_chat(cx);
                    Self::send_to(chat, &outgoing, true, cx);
                }
                Err(e) => this.failed(&e, this.theme.strings.send_failed, cx),
            },
        );
    }

    /// Posts the whole message; a new chat first takes the controls the owner chose.
    fn send_to(chat: ChatRef, outgoing: &Outgoing, new_chat: bool, cx: &mut Context<Self>) {
        let body = outgoing.body(&chat.chat.0, &client_message_id());
        let controls = outgoing.session_controls().filter(|_| new_chat);
        let session = chat.session.0.to_string();
        let posted = Jobs::run(cx, move |client| async move {
            if let Some(controls) = controls {
                let _ = client.update_session_controls(&session, &controls).await;
            }
            client.post_message_body(&body).await
        });
        let sent: Fetch<SentTurn> = Box::pin(async move {
            match posted.await {
                Some(Ok(raw)) => sent_turn(&raw),
                Some(Err(error)) => Err(source_error(&error)),
                None => Err(SourceError::Disconnected),
            }
        });
        Self::run(sent, cx, move |this, result, cx| match result {
            Ok(sent) => {
                this.store.turn_started(&chat.chat, sent.turn);
                this.sync_composer(cx);
            }
            Err(e) => this.chat_failed(&chat, &e, this.theme.strings.send_failed, cx),
        });
    }

    /// What the composer needs of the open chat and the agent.
    fn composer_inputs(&self) -> Inputs {
        let chat = self.store.selected();
        let mut inputs = Inputs::from_summary(self.session_menu.summary.as_ref());
        inputs.connected = self.source.is_some() && !self.incompatible;
        inputs.chat_id = chat.map(|c| c.chat.0.to_string());
        inputs.session_id = chat.map(|c| c.session.0.to_string());
        inputs.project_id = chat
            .and_then(|c| self.store.summary(c))
            .and_then(|row| row.space.as_ref())
            .filter(|space| space.project)
            .map(|space| space.id.to_string());
        inputs.reconnecting = self.source.is_some() && self.attention.disconnected;
        inputs
    }

    /// Tells the composer about the chat; it acts only on what changed.
    pub(super) fn feed_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let inputs = self.composer_inputs();
        self.composer
            .update(cx, |composer, cx| composer.set_inputs(inputs, window, cx));
    }

    pub(super) fn on_composer(
        &mut self,
        _: &Entity<Composer>,
        event: &ComposerEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            ComposerEvent::Send(outgoing) => self.send(outgoing.as_ref().clone(), cx),
            ComposerEvent::Stop => self.stop(cx),
            ComposerEvent::OpenUsageSettings => self.open_settings("usage", window, cx),
        }
    }

    /// Shell init: the image viewer host, and what deletes a queued message that is loaded
    /// into the composer for editing.
    pub(super) fn install_composer(cx: &mut Context<Self>) {
        image_viewer::install(cx);
        // An answered request or question: the open view (which carries the requests) is read
        // again.
        let shell = cx.entity().downgrade();
        decisions::on_authority_changed(cx, move |_, cx| {
            let _ = shell.update(cx, Shell::refresh_open_view);
        });
        let shell = cx.entity().downgrade();
        decisions::on_question_answered(cx, move |cx| {
            let _ = shell.update(cx, Shell::refresh_open_view);
        });
        // The plan decision's bridge. `open_plan` does nothing until the transcript has a
        // scroll-to helper (`onOpenPlan` scrolls to the plan document).
        let shell = cx.entity().downgrade();
        decisions::set_plan_bridge(
            cx,
            decisions::PlanBridge {
                open_plan: Rc::new(|_, _| {}),
                text: Rc::new(composer_text),
                clear_text: Rc::new(clear_composer_text),
                open_instruction: Rc::new(focus_composer),
                decided: Rc::new(move |result, cx| {
                    let plan_mode = result.controls.controls.plan_mode;
                    let _ = shell.update(cx, |this, cx| {
                        this.composer
                            .update(cx, |c, cx| c.apply_server_plan_mode(plan_mode, cx));
                        this.refresh_open_view(cx);
                    });
                }),
            },
        );
        Self::install_navigation_hooks(cx);
        on_delete_queued(cx, |id, cx| {
            let id = id.to_owned();
            let fetch = Jobs::run(cx, move |client| async move {
                client.delete_queued_message(&id).await
            });
            cx.spawn(async move |cx| {
                let deleted = fetch.await;
                cx.update(|cx| {
                    if matches!(deleted, Some(Err(_))) {
                        let lang = Ds::get(cx).lang();
                        toast::show(cx, Toast::error(words(lang).queue_failed));
                    }
                    crate::ui::chat::queue_changed(cx);
                });
            })
            .detach();
        });
    }

    /// The navigation and refresh hooks the decision panels and the task graph call
    /// (`openSession`, `openSessionObserver`, `refreshSessionView`). Opening a session goes
    /// through the shell's pending navigation (taken on the next frame, which has the window).
    /// Memory settings open on the next frame (the hook has no window); schedules are a P3
    /// screen and say so until then.
    fn install_navigation_hooks(cx: &mut Context<Self>) {
        let open = |cx: &mut Context<Self>| -> OpenHook {
            let shell = cx.entity().downgrade();
            Rc::new(move |id: &str, cx: &mut App| {
                let id = id.to_owned();
                let _ = shell.update(cx, |this, cx| {
                    this.pending_navigation = Some(Navigation::Session(id));
                    cx.notify();
                });
            })
        };
        let not_yet = |cx: &mut Context<Self>| -> Rc<dyn Fn(&mut App)> {
            let shell = cx.entity().downgrade();
            Rc::new(move |cx: &mut App| {
                let _ = shell.update(cx, |this, cx| {
                    toast::show(cx, Toast::message(this.theme.strings.not_yet));
                });
            })
        };
        let refresh = cx.entity().downgrade();
        let memory = cx.entity().downgrade();
        let schedule = not_yet(cx);
        let hooks = decisions::InitiatedHooks {
            open_session: Some(open(cx)),
            // The observer over the parent is not ported; the subtask's own chat opens.
            open_observer: Some(open(cx)),
            open_automation: Some(Rc::new(move |_, cx| schedule(cx))),
            // `InitiatedPanels.tsx:25`: `openSettings("memory")`.
            open_memory_settings: Some(Rc::new(move |cx: &mut App| {
                let _ = memory.update(cx, |this, cx| {
                    this.pending_settings = Some("memory".to_owned());
                    cx.notify();
                });
            })),
            refresh_session: Some(Rc::new(move |_, cx| {
                let _ = refresh.update(cx, Shell::refresh_open_view);
            })),
        };
        cx.set_global(hooks);
        let observer = open(cx);
        inspector::on_open_session_observer(cx, move |id, cx| observer(id, cx));
    }
}
