//! The flow (`useFirstRunFlow.ts`, `useFirstRunStages.ts`, `connectionActions`,
//! `useConsentScreen`): where the user is, the values derived from the controllers, and every
//! transition the screens call through `cx.listener`.
use std::rc::Rc;

use gpui::{App, AppContext as _, Context, SharedString, Window};

use super::commit::{Commit, PendingConnection};
use super::key::{CustomEvent, CustomServer, KeyEvent, KeyForm};
use super::providers::{self, CardId, CardKind, LocalModelOption};
use super::sign_in::SignIn;
use super::welcome::Consent;
use super::{Mode, Onboarding, OnboardingEvent};

/// `useConsentScreen`: the screen before a connection settles the flow on the AI step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Screen {
    Welcome,
    Consent,
    Memory,
    Connect,
}

/// `FirstRunStep`: the step shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    Welcome,
    Consent,
    Memory,
    Import,
    Connect,
    Ready,
}

impl Step {
    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::Welcome => "welcome",
            Self::Consent => "consent",
            Self::Memory => "memory",
            Self::Import => "import",
            Self::Connect => "connect",
            Self::Ready => "ready",
        }
    }
}

/// The AI step's substeps: ① pick, ② sign in / key / model, ③ reply language.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AiStage {
    Pick,
    Auth,
    Reply,
}

impl AiStage {
    fn id(self) -> &'static str {
        match self {
            Self::Pick => "pick",
            Self::Auth => "auth",
            Self::Reply => "reply",
        }
    }
}

/// ② for a card: sign-in, its key form, Other, or Other's models.
#[derive(Clone, Debug, Default)]
pub(crate) enum ConnectView {
    #[default]
    List,
    SignIn,
    Key(CardId),
    Custom,
    CustomModels {
        options: Rc<[LocalModelOption]>,
        api_key: Option<SharedString>,
    },
}

/// `useFirstRunStages`.
#[expect(
    clippy::struct_excessive_bools,
    reason = "useFirstRunStages' independent useState flags"
)]
#[derive(Default)]
pub(crate) struct Stages {
    pub(crate) view: ConnectView,
    /// First run only: the optional import step sits between the connection and the finish.
    pub(crate) import_done: bool,
    pub(crate) auth_done: bool,
    pub(crate) reply_done: bool,
    pub(crate) advance_on_connect: bool,
}

/// `connectionView`.
fn connection_view(card: CardId) -> ConnectView {
    match providers::card(card).kind {
        CardKind::SignIn => ConnectView::SignIn,
        CardKind::Key => ConnectView::Key(card),
        CardKind::Custom => ConnectView::Custom,
    }
}

/// Derived values (`useFirstRunFlow.ts:94-124`).
impl Onboarding {
    /// A live or saved connection keeps the flow on the AI step.
    pub(crate) fn settled(&self, cx: &App) -> bool {
        let commit = self.commit.read(cx);
        commit.connected().is_some()
            || commit.waiting_for_ready(self.readiness.read(cx).view().status)
    }

    pub(crate) fn step(&self, cx: &App) -> Step {
        if !self.stages.reply_done {
            if self.settled(cx) {
                return Step::Connect;
            }
            return match self.screen {
                Screen::Welcome => Step::Welcome,
                Screen::Consent => Step::Consent,
                Screen::Memory => Step::Memory,
                Screen::Connect => Step::Connect,
            };
        }
        if self.mode == Mode::FirstRun && !self.stages.import_done {
            Step::Import
        } else {
            Step::Ready
        }
    }

    /// A saved connection, a confirmed ② or a model pick that just connected opens ③.
    pub(crate) fn ai_stage(&self, cx: &App) -> AiStage {
        let commit = self.commit.read(cx);
        let connected = commit.connected().is_some();
        let list = matches!(self.stages.view, ConnectView::List);
        let advanced = self.stages.auth_done || (self.stages.advance_on_connect && connected);
        if advanced || ((connected || commit.saved_card().is_some()) && list) {
            AiStage::Reply
        } else if list {
            AiStage::Pick
        } else {
            AiStage::Auth
        }
    }

    /// The card's key: `connect:<stage>`, `import:<page>`, or the step.
    pub(crate) fn stage_key(&self, cx: &App) -> SharedString {
        match self.step(cx) {
            Step::Connect => format!("connect:{}", self.ai_stage(cx).id()).into(),
            Step::Import => format!("import:{}", self.imports.read(cx).page_key()).into(),
            step => step.id().into(),
        }
    }

    /// Only the AI step has substeps: (index from 1, total).
    pub(crate) fn substep(&self, cx: &App) -> Option<(usize, usize)> {
        (self.step(cx) == Step::Connect).then(|| (self.ai_stage(cx) as usize + 1, 3))
    }

    /// `currentCardId`: the connected card, else the one in use (rerun).
    pub(crate) fn current_card_id(&self, cx: &App) -> Option<CardId> {
        self.commit
            .read(cx)
            .connected()
            .map(|(card, _)| card)
            .or(self.current_card)
    }
}

/// Navigation (`useConsentScreen`); declining never changes durable onboarding.
impl Onboarding {
    pub(crate) fn start(&mut self, cx: &mut Context<Self>) {
        self.screen = Screen::Consent;
        self.sync(cx);
    }

    pub(crate) fn back_to_welcome(&mut self, cx: &mut Context<Self>) {
        self.focus_start = true;
        self.screen = Screen::Welcome;
        self.sync(cx);
    }

    pub(crate) fn back_to_consent(&mut self, cx: &mut Context<Self>) {
        self.screen = Screen::Consent;
        self.sync(cx);
    }

    /// The first run returns to the memory step; renewal and rerun to consent.
    pub(crate) fn back_from_connect(&mut self, cx: &mut Context<Self>) {
        self.screen = if self.mode == Mode::FirstRun {
            Screen::Memory
        } else {
            Screen::Consent
        };
        self.sync(cx);
    }

    pub(crate) fn decline(&mut self, cx: &mut Context<Self>) {
        self.consent.update(cx, Consent::clear);
        self.focus_start = true;
        self.screen = Screen::Welcome;
        self.sync(cx);
    }

    /// Rerun only: leave without changing anything.
    pub(crate) fn cancel(&mut self, cx: &mut Context<Self>) {
        self.sign_in.update(cx, SignIn::leave);
        cx.emit(OnboardingEvent::Cancel);
    }
}

/// The connection (`connectionActions`, `stageActions`).
impl Onboarding {
    /// Selecting a provider only opens its connection screen.
    pub(crate) fn pick(&mut self, card: CardId, window: &mut Window, cx: &mut Context<Self>) {
        self.stages.auth_done = false;
        self.stages.reply_done = false;
        self.stages.advance_on_connect = false;
        self.commit.update(cx, Commit::clear);
        self.show(connection_view(card), window, cx);
        self.sync(cx);
    }

    pub(crate) fn back_to_list(&mut self, cx: &mut Context<Self>) {
        self.sign_in.update(cx, SignIn::leave);
        self.commit.update(cx, Commit::clear);
        self.stages = Stages::default();
        self.key = None;
        self.custom = None;
        self.sync(cx);
    }

    /// `toReply`: ② done, the connection is live; ③ asks the reply language.
    pub(crate) fn open_reply(&mut self, cx: &mut Context<Self>) {
        self.stages.auth_done = true;
        self.sync(cx);
    }

    /// ② for a model pick: connect, then open ③ once connected.
    pub(crate) fn connect_and_advance(
        &mut self,
        card: CardId,
        option: LocalModelOption,
        api_key: Option<SharedString>,
        cx: &mut Context<Self>,
    ) {
        self.stages.advance_on_connect = true;
        self.submit(
            PendingConnection::Local {
                card,
                option,
                api_key,
            },
            cx,
        );
    }

    /// A verified key: routine presets are for a new AI; the AI in use keeps its model.
    pub(crate) fn connect_key(
        &mut self,
        card: CardId,
        credential_id: SharedString,
        cx: &mut Context<Self>,
    ) {
        let connection = PendingConnection::Hosted {
            card,
            provider_id: providers::card(card).provider_id.unwrap_or_default(),
            auth_type: "api_key",
            credential_id: Some(credential_id),
            keep_defaults: self.current_card == Some(card),
        };
        self.submit(connection, cx);
    }

    pub(crate) fn connect_chatgpt(&mut self, cx: &mut Context<Self>) {
        self.stages.advance_on_connect = true;
        let connection = PendingConnection::Hosted {
            card: CardId::Chatgpt,
            provider_id: "openai",
            auth_type: "chatgpt_oauth",
            credential_id: None,
            keep_defaults: self.current_card == Some(CardId::Chatgpt),
        };
        self.submit(connection, cx);
    }

    pub(crate) fn show_custom_models(
        &mut self,
        options: Rc<[LocalModelOption]>,
        api_key: Option<SharedString>,
        cx: &mut Context<Self>,
    ) {
        self.stages.view = ConnectView::CustomModels { options, api_key };
        self.sync(cx);
    }

    /// The commit-failed notice's Retry.
    pub(crate) fn retry_commit(&mut self, cx: &mut Context<Self>) {
        self.commit.update(cx, Commit::retry);
        self.sync(cx);
    }

    fn submit(&mut self, connection: PendingConnection, cx: &mut Context<Self>) {
        self.commit
            .update(cx, |commit, cx| commit.submit(connection, cx));
        self.sync(cx);
    }

    /// Opens ② for a card; a key form or Other is built anew, as React remounts it.
    fn show(&mut self, view: ConnectView, window: &mut Window, cx: &mut Context<Self>) {
        self.key = match view {
            ConnectView::Key(card) => {
                let form = cx.new(|cx| KeyForm::new(card, window, cx));
                cx.subscribe(&form, |this, _, event: &KeyEvent, cx| {
                    let KeyEvent::Saved {
                        card,
                        credential_id,
                    } = event;
                    this.connect_key(*card, credential_id.clone(), cx);
                })
                .detach();
                Some(form)
            }
            _ => None,
        };
        self.custom = match view {
            ConnectView::Custom => {
                let server = cx.new(|cx| CustomServer::new(window, cx));
                cx.subscribe(&server, Self::on_custom).detach();
                Some(server)
            }
            _ => None,
        };
        self.stages.view = view;
    }

    fn on_custom(
        &mut self,
        _: gpui::Entity<CustomServer>,
        event: &CustomEvent,
        cx: &mut Context<Self>,
    ) {
        match event {
            CustomEvent::Models { options, api_key } => {
                self.show_custom_models(options.clone(), api_key.clone(), cx);
            }
            CustomEvent::Pick { option, api_key } => {
                self.connect_and_advance(CardId::Other, option.clone(), api_key.clone(), cx);
            }
        }
    }
}

/// The later steps.
impl Onboarding {
    /// ③ back to ②; the live connection stays, also after a resume (which starts on ③).
    pub(crate) fn back_from_reply(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let commit = self.commit.read(cx);
        let card = commit
            .connected()
            .map(|(card, _)| card)
            .or(commit.saved_card());
        if matches!(self.stages.view, ConnectView::List)
            && let Some(card) = card
        {
            self.show(connection_view(card), window, cx);
        }
        self.stages.auth_done = false;
        self.sync(cx);
    }

    pub(crate) fn back_from_import(&mut self, cx: &mut Context<Self>) {
        self.stages.reply_done = false;
        self.sync(cx);
    }

    pub(crate) fn finish_import(&mut self, cx: &mut Context<Self>) {
        self.stages.import_done = true;
        self.sync(cx);
    }

    /// Ready goes back to the import step on the first run, else to ③.
    pub(crate) fn back_from_ready(&mut self, cx: &mut Context<Self>) {
        if self.mode == Mode::FirstRun {
            self.stages.import_done = false;
        } else {
            self.stages.reply_done = false;
        }
        self.sync(cx);
    }
}
