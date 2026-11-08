//! Committing the connection and the reply language (`useConnectionCommit`,
//! `app/setupConnection.ts`, `FirstRunReplyLanguage`, `useReplyLanguage`).

mod copy;
mod register;
mod reply;

use std::fmt;
use std::rc::Rc;

use butler_ds::ui::context::Lang;
use butler_shell_client::Error;
use chrono::{SecondsFormat, Utc};
use gpui::{Context, EventEmitter, SharedString};
use serde_json::Value;

pub(crate) use reply::{Reply, ReplyEvent, reply_screen};

use self::copy::words;
use self::register::{Registration, commit_connection};
use super::providers::{self, CardId, LocalModelOption};
use super::readiness::ReadinessStatus;
use super::{Mode, gate};
use crate::ui::settings::state::fetch;

/// The connection to commit once Butler is ready.
#[derive(Clone)]
pub(crate) enum PendingConnection {
    Hosted {
        card: CardId,
        provider_id: &'static str,
        auth_type: &'static str,
        credential_id: Option<SharedString>,
        /// The AI already in use keeps its model and effort.
        keep_defaults: bool,
    },
    Local {
        card: CardId,
        option: LocalModelOption,
        api_key: Option<SharedString>,
    },
}

impl PendingConnection {
    fn card(&self) -> CardId {
        match self {
            Self::Hosted { card, .. } | Self::Local { card, .. } => *card,
        }
    }
}

/// Never prints the API key.
impl fmt::Debug for PendingConnection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Hosted {
                card,
                provider_id,
                auth_type,
                keep_defaults,
                ..
            } => f
                .debug_struct("Hosted")
                .field("card", card)
                .field("provider_id", provider_id)
                .field("auth_type", auth_type)
                .field("keep_defaults", keep_defaults)
                .finish_non_exhaustive(),
            Self::Local { card, option, .. } => f
                .debug_struct("Local")
                .field("card", card)
                .field("option", option)
                .finish_non_exhaustive(),
        }
    }
}

/// Connected: the settings and the model catalog after the commit (the card is
/// [`Commit::connected`]'s).
pub(crate) enum CommitEvent {
    Connected(Rc<Value>, Rc<Value>),
}

/// The `language` setting for a UI language.
fn code(lang: Lang) -> &'static str {
    match lang {
        Lang::Ko => "ko",
        Lang::En => "en",
    }
}

/// `savedConnection`: a first run that stopped after consent keeps its connection.
fn saved_connection(
    resume: bool,
    settings: &Rc<Value>,
    catalog: &Value,
) -> Option<(CardId, Rc<Value>)> {
    if !resume {
        return None;
    }
    let onboarding = settings.get("onboarding")?;
    let has = |key: &str| {
        onboarding
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
    };
    if !has("accepted_at") || !gate::consent_is_current(onboarding) || has("completed_at") {
        return None;
    }
    let model_ref = settings.get("model")?.as_str()?;
    let model = catalog
        .get("registered_models")?
        .as_array()?
        .iter()
        .find(|model| model.get("model_ref").and_then(Value::as_str) == Some(model_ref))?;
    providers::connection_card_id(model).map(|card| (card, settings.clone()))
}

pub(crate) struct Commit {
    saved: Option<(CardId, Rc<Value>)>,
    /// The catalog at the start, for a saved connection.
    catalog: Rc<Value>,
    pending: Option<PendingConnection>,
    connected: Option<(CardId, Rc<Value>)>,
    /// The generation of the commit running; `clear` starts a new generation, so a commit that
    /// finishes after it is dropped.
    in_flight: Option<u64>,
    failed: bool,
    generation: u64,
}

impl EventEmitter<CommitEvent> for Commit {}

impl Commit {
    pub(crate) fn new(
        mode: Mode,
        settings: &Rc<Value>,
        catalog: Rc<Value>,
        cx: &mut Context<Self>,
    ) -> Self {
        let _ = cx;
        Self {
            saved: saved_connection(mode == Mode::FirstRun, settings, &catalog),
            catalog,
            pending: None,
            connected: None,
            in_flight: None,
            failed: false,
            generation: 0,
        }
    }

    pub(crate) fn connected(&self) -> Option<(CardId, Rc<Value>)> {
        self.connected.clone()
    }

    /// A saved connection (resume on the first run).
    pub(crate) fn saved_card(&self) -> Option<CardId> {
        self.saved.as_ref().map(|(card, _)| *card)
    }

    pub(crate) fn failed(&self) -> bool {
        self.failed
    }

    /// `committing`: a commit is running.
    pub(crate) fn committing(&self) -> bool {
        self.in_flight == Some(self.generation)
    }

    /// A choice is made but Butler is still getting ready.
    pub(crate) fn waiting_for_ready(&self, status: ReadinessStatus) -> bool {
        (self.saved.is_some() && self.connected.is_none())
            || (self.pending.is_some() && status != ReadinessStatus::Ready)
    }

    pub(crate) fn submit(&mut self, connection: PendingConnection, cx: &mut Context<Self>) {
        self.failed = false;
        self.pending = Some(connection);
        cx.notify();
    }

    /// The commit effect: the frame calls it on every flow change; it connects a saved
    /// connection or commits a pending one once `status` is ready, and only once.
    pub(crate) fn drive(
        &mut self,
        status: ReadinessStatus,
        accepted_at: Option<SharedString>,
        lang: Lang,
        cx: &mut Context<Self>,
    ) {
        if status != ReadinessStatus::Ready || self.connected.is_some() {
            return;
        }
        if let Some((card, settings)) = self.saved.clone() {
            self.connect(card, settings, self.catalog.clone(), cx);
            return;
        }
        if self.failed || self.committing() {
            return;
        }
        if let Some(pending) = self.pending.clone() {
            self.start(&pending, accepted_at, lang, cx);
        }
    }

    pub(crate) fn retry(&mut self, cx: &mut Context<Self>) {
        self.failed = false;
        cx.notify();
    }

    pub(crate) fn clear(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        self.failed = false;
        self.saved = None;
        self.pending = None;
        self.connected = None;
        cx.notify();
    }

    fn connect(
        &mut self,
        card: CardId,
        settings: Rc<Value>,
        catalog: Rc<Value>,
        cx: &mut Context<Self>,
    ) {
        self.connected = Some((card, settings.clone()));
        cx.emit(CommitEvent::Connected(settings, catalog));
        cx.notify();
    }

    fn start(
        &mut self,
        pending: &PendingConnection,
        accepted_at: Option<SharedString>,
        lang: Lang,
        cx: &mut Context<Self>,
    ) {
        let generation = self.generation;
        self.in_flight = Some(generation);
        let card = pending.card();
        let registration = Registration::new(pending);
        let language = code(lang);
        let label = words(lang).default_profile;
        let accepted_at = accepted_at.map_or_else(
            || Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            |at| at.to_string(),
        );
        fetch(
            cx,
            move |client| commit_connection(client, registration, language, accepted_at, label),
            move |this: &mut Self, result: Result<Value, Error>, cx| {
                if this.generation == generation {
                    this.finished(card, result.ok(), cx);
                }
            },
        );
    }

    /// The commit answered: connected, or failed (the pending choice stays for Retry).
    fn finished(&mut self, card: CardId, raw: Option<Value>, cx: &mut Context<Self>) {
        self.in_flight = None;
        let committed = raw.and_then(|raw| {
            Some((
                Rc::new(raw.get("settings")?.clone()),
                Rc::new(raw.get("catalog")?.clone()),
            ))
        });
        match committed {
            Some((settings, catalog)) => {
                self.pending = None;
                self.connect(card, settings, catalog, cx);
            }
            None => self.failed = true,
        }
    }
}
