//! The shell's side of the composer: what it tells the composer about the open chat, what it
//! does with the composer's events, and the handlers the composer installs once.
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use gpui::{App, BorrowAppContext as _, Context, Entity, SharedString, Window};

use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use super::navigation::Navigation;
use super::{Shell, image_viewer};
use crate::ui::chat::AssistantHooks;
use crate::ui::composer::queue::on_delete_queued;
use crate::ui::composer::{
    Composer, ComposerEvent, Inputs, Outgoing, clear_composer_text, composer_text, focus_composer,
};
use crate::ui::decisions;
use crate::ui::i18n::composer::words;
use crate::ui::inspector;
use crate::ui::manage::{ManageCtx, Topic, View};
use crate::ui::source::agent::{Jobs, sent_turn, source_error};
use crate::ui::source::sidebar::DraftTarget;
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
        if let Some(project) = self.dashboard_project(cx) {
            return self.send_dashboard(project, outgoing, cx);
        }
        let Some(source) = self.source.clone() else {
            return;
        };
        if let Some(chat) = self.store.selected().cloned() {
            return Self::send_to(chat, &outgoing, false, None, cx);
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
                    Self::send_to(chat, &outgoing, true, None, cx);
                }
                Err(e) => this.failed(&e, this.theme.strings.send_failed, cx),
            },
        );
    }

    /// The dashboard's send (`dashboardTarget`): a new chat of the project takes the message and
    /// the dashboard stays the view; its topic moves once the turn is accepted.
    fn send_dashboard(
        &mut self,
        project: SharedString,
        outgoing: Outgoing,
        cx: &mut Context<Self>,
    ) {
        let Some(source) = self.source.clone() else {
            return;
        };
        let target = DraftTarget::Project(project.to_string());
        Self::run(
            source.create_sidebar_chat(target.body()),
            cx,
            move |this, result, cx| match result {
                Ok(chat) => Self::send_to(chat, &outgoing, true, Some(project), cx),
                Err(e) => this.failed(&e, this.theme.strings.send_failed, cx),
            },
        );
    }

    /// Posts the whole message; a new chat first takes the controls the owner chose. A dashboard
    /// send moves the project's dashboard topic on acceptance.
    fn send_to(
        chat: ChatRef,
        outgoing: &Outgoing,
        new_chat: bool,
        dashboard: Option<SharedString>,
        cx: &mut Context<Self>,
    ) {
        let outgoing = outgoing.clone();
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
                if let Some(project) = dashboard {
                    this.bump_topic(Topic::Dashboard(project), cx);
                }
                this.sync_composer(cx);
            }
            Err(e) => {
                if this.store.selected() == Some(&chat) {
                    outgoing.restore_rejected(cx);
                }
                this.chat_failed(&chat, &e, this.theme.strings.send_failed, cx);
            }
        });
    }

    /// What the composer needs of the open chat and the agent. On the dashboard it writes the
    /// project's next chat under the draft key `dashboard:<project>` (D4).
    fn composer_inputs(&self, cx: &App) -> Inputs {
        let dashboard = self.dashboard_project(cx);
        let chat = self.store.selected().filter(|_| dashboard.is_none());
        let summary = self.session_menu.summary.as_ref();
        let mut inputs = Inputs::from_summary(summary.filter(|_| dashboard.is_none()));
        inputs.connected = self.source.is_some() && !self.incompatible;
        // Electron `store.ts summaryFromSessionView`: the shown view owns live turn state.
        if let Some(view) = self.store.shown_view().filter(|view| {
            chat.is_some_and(|chat| chat.session.0.as_ref() == view.session_id.as_str())
        }) {
            let turn = view.latest_turn.as_ref();
            inputs.turn_state = Some(turn.map_or("idle", |turn| turn.state.as_str()).to_owned());
            inputs.latest_turn_cancellable = turn.map(|turn| turn.cancellable);
            inputs.progress = turn.and_then(|turn| turn.progress.clone());
        }
        inputs.epic = chat.is_some_and(|chat| self.sidebar.epic_of(&chat.session.0).is_some());
        inputs.chat_id = chat.map(|c| c.chat.0.to_string());
        inputs.session_id = chat.map(|c| c.session.0.to_string());
        inputs.project_id = chat
            .and_then(|c| self.store.summary(c))
            .and_then(|row| row.space.as_ref())
            .filter(|space| space.project)
            .map(|space| space.id.to_string())
            .or_else(|| dashboard.as_ref().map(ToString::to_string));
        inputs.draft_key = dashboard.map(|project| format!("dashboard:{project}"));
        inputs.reconnecting = self.source.is_some() && self.attention.disconnected;
        inputs
    }

    /// Tells the composer about the chat; it acts only on what changed.
    pub(super) fn feed_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let inputs = self.composer_inputs(cx);
        self.composer
            .update(cx, |composer, cx| composer.set_inputs(inputs, window, cx));
        self.attach_pending_document(cx);
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
    pub(super) fn install_composer(manage: &ManageCtx, cx: &mut Context<Self>) {
        image_viewer::install(cx);
        crate::ui::images::install(manage.live.clone(), cx);
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
        Self::install_navigation_hooks(manage, cx);
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

    /// The navigation and refresh hooks the decision panels, the task graph and the transcript
    /// call (`openSession`, `openSessionObserver`, `setView(automation-detail)`,
    /// `refreshSessionView`). Opening a session goes through the shell's pending navigation
    /// (taken on the next frame, which has the window); the management actions go through
    /// `manage`, whose events reach the shell with the window. Memory settings open on the next
    /// frame.
    fn install_navigation_hooks(manage: &ManageCtx, cx: &mut Context<Self>) {
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
        let observe = |manage: &ManageCtx| -> OpenHook {
            let manage = manage.clone();
            Rc::new(move |id: &str, cx: &mut App| {
                manage.open_observer(id.to_owned().into(), None, cx);
            })
        };
        let schedule = manage.clone();
        let refresh = cx.entity().downgrade();
        let memory = cx.entity().downgrade();
        let hooks = decisions::InitiatedHooks {
            open_session: Some(open(cx)),
            open_observer: Some(observe(manage)),
            open_automation: Some(Rc::new(move |id: &str, cx: &mut App| {
                schedule.set_view(View::AutomationDetail(id.to_owned().into()), cx);
            })),
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
        let observer = observe(manage);
        inspector::on_open_session_observer(cx, move |id, cx| observer(id, cx));
        // `WorkerCallCapsule` and the subtask rows (`openSessionObserver`).
        let observer = observe(manage);
        cx.update_default_global(|hooks: &mut AssistantHooks, _| {
            hooks.open_observer = Some(observer);
        });
    }
}
