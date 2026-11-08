//! Runs the [`Source`] requests the shell needs and hands the results to the [`Store`]. Each
//! snapshot (connect, resync) gets its own live stream, started after the snapshot's event
//! cursor; a stream or result of an older snapshot is dropped.
use futures::StreamExt as _;
use gpui::{Context, Window};

use super::Shell;
use crate::ui::i18n::Locale;
use crate::ui::source::agent::MonitorSignal;
use crate::ui::source::{ChatRef, EventCursor, Fetch, SourceError};
use crate::ui::store::{Applied, ChatsLoad};

/// `watchAppLogging`'s events: the App's log level is read again.
fn logging_changed(kind: &str, payload: &serde_json::Value) -> bool {
    matches!(kind, "logs.cleared" | "stream.reconcile_required")
        || (kind == "settings.updated"
            && ["log_level", "log_category_levels", "diagnostics_enabled"]
                .iter()
                .any(|key| payload["settings"].get(key).is_some()))
}

impl Shell {
    /// Runs `fetch` and hands its result to `done` on the UI thread.
    pub(crate) fn run<T: 'static>(
        fetch: Fetch<T>,
        cx: &mut Context<Self>,
        done: impl FnOnce(&mut Self, Result<T, SourceError>, &mut Context<Self>) + 'static,
    ) {
        cx.spawn(async move |this, cx| {
            let result = fetch.await;
            let _ = this.update(cx, |this, cx| done(this, result, cx));
        })
        .detach();
    }

    /// Receives filesystem-driven attach changes on gpui's executor.
    pub(crate) fn attach(
        &mut self,
        mut attachment: crate::ui::source::agent::Attachment,
        cx: &mut Context<Self>,
    ) {
        self.rediscover = Some(attachment.retry.clone());
        self.connection_task = Some(cx.spawn(async move |this, cx| {
            while let Some((source, jobs)) = attachment.next().await {
                if this
                    .update(cx, |this, cx| {
                        cx.set_global(jobs);
                        this.lost(cx);
                        this.incompatible = false;
                        this.source = source;
                        this.sync_composer(cx);
                        this.connect(cx);
                    })
                    .is_err()
                {
                    return;
                }
            }
        }));
    }

    /// A fresh snapshot: the first page of chats, then live updates after its cursor.
    pub(super) fn connect(&mut self, cx: &mut Context<Self>) {
        if self.source.is_some() {
            self.store.navigation.in_flight = false;
            self.store.navigation.dirty = false;
            self.store.navigation.generation += 1;
            self.sidebar.begin_snapshot();
            self.load_settings(cx);
            let load = self.store.begin_snapshot();
            self.load_chats(load, cx);
            self.refresh_sidebar(cx);
            self.refresh_sidebar_update(cx);
            // `watchAppLogging` / `watchAppUserWork` on (re)connect.
            crate::lifecycle::logs::refresh(cx);
            crate::lifecycle::app_update::work_changed(cx);
        }
    }

    /// The app's language setting (`settings.language`: Settings, else `user.language`, else
    /// English). The OS locale stands until it is known.
    fn load_chats(&mut self, load: ChatsLoad, cx: &mut Context<Self>) {
        let Some(source) = self.source.clone() else {
            return;
        };
        Self::run(source.chats(), cx, move |this, result, cx| {
            match result {
                Ok(page) => {
                    if let Some(after) = this.store.chats_loaded(&load, page) {
                        if let Some(monitor) = &this.rediscover {
                            let _ = monitor.send(MonitorSignal::SnapshotLoaded);
                        }
                        this.connected_notice(cx);
                        this.sync_attention(cx);
                        this.subscribe(load.epoch, after, cx);
                        this.reload_open_chat(cx);
                    }
                }
                Err(e) => {
                    this.store.chats_failed(&load);
                    this.failed(&e, this.theme.strings.load_failed, cx);
                }
            }
            cx.notify();
        });
    }

    fn subscribe(&mut self, epoch: u64, after: EventCursor, cx: &mut Context<Self>) {
        let Some(source) = self.source.clone() else {
            return;
        };
        let mut live = source.live(after);
        self.live_task = Some(cx.spawn(async move |this, cx| {
            while let Some(event) = live.next().await {
                let current = this.update(cx, |this, cx| {
                    if this.store.epoch() != epoch {
                        return false;
                    }
                    this.apply(epoch, event, cx);
                    true
                });
                if !matches!(current, Ok(true)) {
                    return;
                }
            }
        }));
    }

    fn apply(&mut self, epoch: u64, event: crate::ui::source::LiveEvent, cx: &mut Context<Self>) {
        let sidebar_event = match &event.update {
            crate::ui::source::LiveUpdate::NavigationEvent(e) => Some(e.clone()),
            _ => None,
        };
        // `settings.updated` carries the changed subset; a language in it switches the UI.
        if let crate::ui::source::LiveUpdate::NavigationEvent(e) = &event.update
            && e.r#type == "settings.updated"
            && let Some(language) = e.payload["settings"]["language"].as_str()
        {
            self.set_locale(Locale::from_language(language), cx);
        }
        // Each committed event: the App's log level may change, and the work a deferred App
        // update waits on may settle.
        if let crate::ui::source::LiveUpdate::NavigationEvent(e) = &event.update {
            if logging_changed(&e.r#type, &e.payload) {
                crate::lifecycle::logs::refresh(cx);
            }
            crate::lifecycle::app_update::work_changed(cx);
        }
        let attention_changed = matches!(&event.update, crate::ui::source::LiveUpdate::Chat(_));
        if let crate::ui::source::LiveUpdate::Inspector(envelope) = &event.update {
            crate::ui::inspector::live_event(envelope, cx);
        }
        match self.store.apply(epoch, event) {
            Applied::Store => {}
            Applied::Failed(error) => self.failed(&error, self.theme.strings.load_failed, cx),
            Applied::Transcript => self.show_view(true, cx),
            Applied::Resync => self.connect(cx),
            Applied::Refresh => self.refresh_open_view(cx),
        }
        if let Some(event) = sidebar_event {
            self.sidebar_live_event(&event, cx);
        }
        if self.store.view_stale() {
            self.refresh_open_view(cx);
        }
        if attention_changed {
            self.sync_attention(cx);
        }
        self.sync_composer(cx);
        cx.notify();
    }

    /// Opens `chat` from its latest messages (`None`: a new chat).
    pub(crate) fn open_chat(
        &mut self,
        chat: Option<ChatRef>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.source.is_none() {
            return;
        }
        let new_chat = chat.is_none();
        self.session_menu.rename = None;
        if let Some(chat) = &chat {
            self.load_summary(chat, cx);
        } else {
            self.session_menu.summary = None;
        }
        self.store.open(chat);
        self.chat.update(cx, |c, _| c.set_new_chat(new_chat));
        if let Some(id) = self.store.selected().map(|c| c.session.0.to_string()) {
            self.mark_sidebar_read(&id, cx);
        } else {
            self.sidebar.new_chat_parent = None;
        }
        self.show_view(false, cx);
        self.composer.update(cx, |c, cx| {
            if new_chat {
                c.engage(window, cx);
            } else {
                c.fold();
            }
        });
        self.reload_open_chat(cx);
        self.sync_composer(cx);
        cx.notify();
    }

    pub(crate) fn open_sidebar_draft(
        &mut self,
        parent: Option<crate::ui::source::sidebar::DraftTarget>,
        cx: &mut Context<Self>,
    ) {
        self.session_menu.rename = None;
        self.session_menu.summary = None;
        self.store.open(None);
        self.sidebar.new_chat_parent = parent;
        self.show_view(false, cx);
        self.composer.update(cx, |_, cx| cx.notify());
        self.sync_composer(cx);
        if let Some(handle) = self.sidebar.window_handle {
            let composer = self.composer.clone();
            let _ = handle.update(cx, move |_, window, cx| {
                composer.update(cx, |c, cx| c.engage(window, cx));
            });
        }
        cx.notify();
    }
    /// Reloads the open chat's latest window and its authority requests.
    pub(crate) fn reload_open_chat(&mut self, cx: &mut Context<Self>) {
        let (Some(chat), Some(source)) = (self.store.selected().cloned(), self.source.clone())
        else {
            return;
        };
        let shown = chat.clone();
        Self::run(
            source.open_session(&chat.session),
            cx,
            move |this, result, cx| match result {
                Ok(view) => {
                    if this.store.view_loaded(&shown, view) {
                        this.show_view(false, cx);
                        this.reload_queue(cx);
                    }
                    this.sync_composer(cx);
                }
                Err(e) => this.chat_failed(&shown, &e, this.theme.strings.load_failed, cx),
            },
        );
        self.reload_authority(&chat, cx);
    }

    fn reload_authority(&mut self, chat: &ChatRef, cx: &mut Context<Self>) {
        let Some(source) = self.source.clone() else {
            return;
        };
        let session = chat.session.clone();
        let chat = chat.clone();
        Self::run(
            source.authority(&chat.session),
            cx,
            move |this, result, cx| match result {
                Ok(cards) => {
                    this.store.authority_loaded(session, cards);
                    this.sync_composer(cx);
                }
                Err(error) => this.chat_failed(&chat, &error, this.theme.strings.load_failed, cx),
            },
        );
    }

    /// The agent went away: back to the disconnected state.
    fn lost(&mut self, cx: &mut Context<Self>) {
        self.live_task = None;
        if self.source.is_some() {
            butler_ds::ui::toast::show(
                cx,
                butler_ds::ui::toast::Toast::message(self.copy("Connection lost", "연결 끊김")),
            );
            self.attention.disconnected = true;
        }
        if self.source.take().is_some()
            && let Some(retry) = &self.rediscover
        {
            let _ = retry.send(MonitorSignal::Retry);
        }
        self.store.lost();
        self.store.navigation.in_flight = false;
        self.store.navigation.dirty = false;
        self.store.navigation.generation += 1;
        self.sidebar.connection_lost();
        self.sync_composer(cx);
        cx.notify();
    }

    /// The composer follows the open chat: the agent, a running turn and its first request.
    pub(crate) fn sync_composer(&mut self, cx: &mut Context<Self>) {
        let streaming = self.store.running().is_some();
        let disabled = self.disconnected();
        self.composer.update(cx, |c, cx| {
            c.streaming = streaming;
            if disabled.is_some() {
                c.fold();
            }
            c.disabled = disabled;
            cx.notify();
        });
    }

    pub(crate) fn stop(&mut self, cx: &mut Context<Self>) {
        let (Some(turn), Some(source)) = (self.store.running().cloned(), self.source.clone())
        else {
            return;
        };
        Self::run(source.cancel(&turn), cx, |this, result, cx| {
            if let Err(e) = result {
                this.failed(&e, this.theme.strings.stop_failed, cx);
            }
        });
    }

    pub(super) fn chat_failed(
        &mut self,
        chat: &ChatRef,
        error: &SourceError,
        toast: &'static str,
        cx: &mut Context<Self>,
    ) {
        if self.store.chat_failed(chat, error) {
            self.show_view(false, cx);
            self.sync_composer(cx);
        }
        self.failed(error, toast, cx);
    }

    /// A failed request: a brief toast, or the disconnected state when the agent is gone.
    pub(crate) fn failed(
        &mut self,
        error: &SourceError,
        toast: &'static str,
        cx: &mut Context<Self>,
    ) {
        butler_ds::ui::toast::show(cx, butler_ds::ui::toast::Toast::error(toast));
        match error {
            SourceError::Disconnected => self.lost(cx),
            SourceError::Incompatible => {
                self.live_task = None;
                self.source = None;
                self.incompatible = true;
                self.store.lost();
                self.sync_composer(cx);
            }
            SourceError::Missing | SourceError::Refused(_) => {}
        }
        cx.notify();
    }
}
