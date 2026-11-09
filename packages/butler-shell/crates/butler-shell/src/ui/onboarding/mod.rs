//! The first run (`FirstRunSetup.tsx`, `useFirstRunFlow.ts`): welcome, consent, memory, pick an
//! AI, import and finish; a consent renewal; or Run setup again from Settings. [`flow`] holds the
//! state and its transitions; each step's controller is an entity its unit owns, and each screen
//! is a render fn over [`Onboarding`]. Every link opens in the user's own browser
//! (`cx.open_url`).

pub(crate) mod card;
pub(crate) mod commit;
pub(crate) mod copy;
mod flow;
pub(crate) mod gate;
pub(crate) mod import;
pub(crate) mod key;
pub(crate) mod legacy;
pub(crate) mod memory;
pub(crate) mod providers;
pub(crate) mod readiness;
pub(crate) mod ready;
pub(crate) mod sign_in;
mod steps;
pub(crate) mod welcome;

use std::rc::Rc;

use butler_ds::ui::blocks::setup_wizard_shell::{
    ContentWidth, SetupWizardAnchor, SetupWizardContent, SetupWizardIntro, SetupWizardShell,
    SetupWizardVariant,
};
use butler_ds::ui::blocks::wallpaper::WallpaperTone;
use butler_ds::ui::context::Lang;
use gpui::{
    AnyElement, AppContext as _, Context, Entity, EventEmitter, FocusHandle, IntoElement,
    ParentElement as _, Render, Styled as _, Subscription, Window, WindowAppearance, div,
};
use serde_json::Value;

pub(crate) use copy::words;
pub(crate) use flow::{AiStage, ConnectView, Screen, Stages, Step};

use crate::ui::i18n::Locale;
use crate::ui::theme::Platform;
use commit::{CommitEvent, ReplyEvent};
use memory::MemoryEvent;
use providers::CardId;
use readiness::ReadinessStatus;
use welcome::ConsentEvent;

/// `FirstRunMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mode {
    FirstRun,
    Consent,
    Rerun,
}

/// What the onboarding tells the window.
pub(crate) enum OnboardingEvent {
    /// Finished with these settings ([`Onboarding::settings`]); the card that connected.
    Complete(Option<CardId>),
    /// Rerun only: left without changes.
    Cancel,
    /// `setAppCopyLanguage`: the app's copy follows the onboarding's language.
    Language(Lang),
}

pub(crate) struct Onboarding {
    pub(crate) mode: Mode,
    /// `initialLanguage`: the OS locale on the first run, `settings.language` otherwise.
    pub(crate) lang: Lang,
    pub(crate) screen: Screen,
    /// Back on welcome: its start button takes the focus.
    pub(crate) focus_start: bool,
    pub(crate) stages: Stages,
    /// The settings while onboarding runs (the window applies them on completion).
    pub(crate) settings: Rc<Value>,
    pub(crate) catalog: Rc<Value>,
    /// `current`: the card of the model in use (rerun only).
    pub(crate) current_card: Option<CardId>,
    pub(crate) consent: Entity<welcome::Consent>,
    pub(crate) readiness: Entity<readiness::Readiness>,
    pub(crate) memory: Entity<memory::MemoryChoice>,
    pub(crate) providers: Entity<providers::LocalServers>,
    pub(crate) sign_in: Entity<sign_in::SignIn>,
    /// Built when the view becomes `Key(card)`.
    pub(crate) key: Option<Entity<key::KeyForm>>,
    /// Built when the view becomes `Custom`.
    pub(crate) custom: Option<Entity<key::CustomServer>>,
    pub(crate) commit: Entity<commit::Commit>,
    pub(crate) reply: Entity<commit::Reply>,
    pub(crate) imports: Entity<import::Imports>,
    /// The step card's title: focused when the card changes.
    pub(crate) title: FocusHandle,
    intro: SetupWizardIntro,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<OnboardingEvent> for Onboarding {}

/// `detectFirstRunLanguage`: Korean when any OS language is Korean.
fn os_lang() -> Lang {
    if sys_locale::get_locales().any(|tag| tag.to_lowercase().starts_with("ko")) {
        Lang::Ko
    } else {
        Lang::En
    }
}

fn settings_lang(settings: &Value) -> Lang {
    Locale::from_language(
        settings
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
    .ds_lang()
}

/// `currentCardId`'s source: the catalog entry of `settings.model`.
fn current_card(mode: Mode, settings: &Value, catalog: &Value) -> Option<CardId> {
    if mode != Mode::Rerun {
        return None;
    }
    let model_ref = settings
        .get("model")
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty())?;
    let model = ["registered_models", "models"]
        .iter()
        .filter_map(|list| catalog.get(*list).and_then(Value::as_array))
        .flatten()
        .find(|model| model.get("model_ref").and_then(Value::as_str) == Some(model_ref))?;
    providers::connection_card_id(model)
}

/// The full intro only on a fresh first run (no consent, never completed); the rerun entrance
/// for Settings; none for a resumed setup.
fn intro(mode: Mode, settings: &Value) -> SetupWizardIntro {
    let onboarding = settings.get("onboarding");
    let has = |key: &str| {
        onboarding
            .and_then(|value| value.get(key))
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
    };
    match mode {
        Mode::FirstRun if !has("accepted_at") && !has("completed_at") => SetupWizardIntro::Full,
        Mode::Rerun => SetupWizardIntro::Rerun,
        _ => SetupWizardIntro::None,
    }
}

impl Onboarding {
    pub(crate) fn new(
        mode: Mode,
        settings: Rc<Value>,
        catalog: Rc<Value>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let _ = window;
        let consent = cx.new(welcome::Consent::new);
        let readiness = cx.new(readiness::Readiness::new);
        let memory = cx.new(memory::MemoryChoice::new);
        let providers = cx.new(providers::LocalServers::new);
        let sign_in = cx.new(sign_in::SignIn::new);
        let commit = cx.new(|cx| commit::Commit::new(mode, &settings, catalog.clone(), cx));
        let reply = cx.new(commit::Reply::new);
        let imports = cx.new(import::Imports::new);
        let subscriptions = vec![
            cx.observe(&consent, |this, _, cx| this.sync(cx)),
            cx.observe(&readiness, |this, _, cx| this.sync(cx)),
            cx.observe(&memory, |_, _, cx| cx.notify()),
            cx.observe(&providers, |_, _, cx| cx.notify()),
            cx.observe(&sign_in, |_, _, cx| cx.notify()),
            cx.observe(&commit, |_, _, cx| cx.notify()),
            cx.observe(&reply, |_, _, cx| cx.notify()),
            cx.observe(&imports, |_, _, cx| cx.notify()),
            cx.subscribe(&consent, Self::on_consent),
            cx.subscribe(&memory, Self::on_memory),
            cx.subscribe(&commit, Self::on_commit),
            cx.subscribe(&reply, Self::on_reply),
        ];
        Self {
            mode,
            lang: if mode == Mode::FirstRun {
                os_lang()
            } else {
                settings_lang(&settings)
            },
            screen: if mode == Mode::Consent {
                Screen::Consent
            } else {
                Screen::Welcome
            },
            focus_start: false,
            stages: Stages::default(),
            current_card: current_card(mode, &settings, &catalog),
            intro: intro(mode, &settings),
            settings,
            catalog,
            consent,
            readiness,
            memory,
            providers,
            sign_in,
            key: None,
            custom: None,
            commit,
            reply,
            imports,
            title: cx.focus_handle(),
            _subscriptions: subscriptions,
        }
    }

    /// The effects React's hooks run on each change: the commit effect, the import sources once
    /// the reply is saved and Butler is ready, the local servers while the AI step shows.
    pub(crate) fn sync(&mut self, cx: &mut Context<Self>) {
        let status = self.readiness.read(cx).view().status;
        let accepted_at = self.consent.read(cx).accepted_at();
        let lang = self.lang;
        self.commit
            .update(cx, |commit, cx| commit.drive(status, accepted_at, lang, cx));
        if self.mode == Mode::FirstRun && self.stages.reply_done && status == ReadinessStatus::Ready
        {
            self.imports.update(cx, import::Imports::enable);
        }
        if self.step(cx) == Step::Connect {
            self.providers.update(cx, providers::LocalServers::refresh);
        }
        cx.notify();
    }

    /// The language the steps and the app's copy use.
    pub(crate) fn set_lang(&mut self, lang: Lang, cx: &mut Context<Self>) {
        if self.lang != lang {
            self.lang = lang;
            cx.emit(OnboardingEvent::Language(lang));
            self.sync(cx);
        }
    }

    fn on_consent(
        &mut self,
        _: Entity<welcome::Consent>,
        event: &ConsentEvent,
        cx: &mut Context<Self>,
    ) {
        let ConsentEvent::Agreed(settings) = event;
        self.settings = settings.clone();
        self.screen = if self.mode == Mode::FirstRun {
            Screen::Memory
        } else {
            Screen::Connect
        };
        self.sync(cx);
    }

    fn on_memory(
        &mut self,
        _: Entity<memory::MemoryChoice>,
        _: &MemoryEvent,
        cx: &mut Context<Self>,
    ) {
        self.screen = Screen::Connect;
        self.sync(cx);
    }

    /// A connection: a model pick that was waiting opens ③; the language follows the connected
    /// settings, and the flow stays on the AI step.
    fn on_commit(
        &mut self,
        _: Entity<commit::Commit>,
        event: &CommitEvent,
        cx: &mut Context<Self>,
    ) {
        let CommitEvent::Connected(settings, catalog) = event;
        self.settings = settings.clone();
        self.catalog = catalog.clone();
        if self.stages.advance_on_connect {
            self.stages.advance_on_connect = false;
            self.stages.auth_done = true;
        }
        self.screen = Screen::Connect;
        self.set_lang(settings_lang(settings), cx);
        self.sync(cx);
    }

    fn on_reply(&mut self, _: Entity<commit::Reply>, event: &ReplyEvent, cx: &mut Context<Self>) {
        match event {
            ReplyEvent::Saved => {
                self.stages.reply_done = true;
                self.sync(cx);
            }
            ReplyEvent::Completed(settings) => {
                self.settings = settings.clone();
                let card = self.commit.read(cx).connected().map(|(card, _)| card);
                cx.emit(OnboardingEvent::Complete(card));
            }
        }
    }

    /// The resolved appearance for the backdrop (`resolveAppearanceTheme`).
    fn tone(&self, window: &Window) -> WallpaperTone {
        let dark = match self
            .settings
            .get("appearance_theme")
            .and_then(Value::as_str)
        {
            Some("dark") => true,
            Some("light") => false,
            _ => matches!(
                window.appearance(),
                WindowAppearance::Dark | WindowAppearance::VibrantDark
            ),
        };
        if dark {
            WallpaperTone::Dark
        } else {
            WallpaperTone::Light
        }
    }

    /// The step's screen; on the AI step, the substep's. Every step but welcome is a step card
    /// in the wide solid frame, which React's `SetupWizardStepCard` draws itself.
    fn body(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let card = match self.step(cx) {
            Step::Welcome => return welcome::screen(self, window, cx),
            Step::Consent => welcome::consent_screen(self, window, cx),
            Step::Memory => memory::screen(self, window, cx),
            Step::Import => import::screen(self, window, cx),
            Step::Ready => ready::screen(self, window, cx),
            Step::Connect => match (self.ai_stage(cx), &self.stages.view) {
                (AiStage::Reply, _) => commit::reply_screen(self, window, cx),
                (AiStage::Auth, ConnectView::SignIn) => sign_in::screen(self, window, cx),
                (AiStage::Auth, ConnectView::Key(_)) => key::key_screen(self, window, cx),
                (AiStage::Auth, ConnectView::Custom | ConnectView::CustomModels { .. }) => {
                    key::custom_screen(self, window, cx)
                }
                (AiStage::Pick | AiStage::Auth, _) => providers::screen(self, window, cx),
            },
        };
        SetupWizardContent::new()
            .width(ContentWidth::Wide)
            .variant(SetupWizardVariant::Focus)
            .solid()
            .child(card)
            .into_any_element()
    }
}

impl Render for Onboarding {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let key = self.stage_key(cx);
        let body = self.body(window, cx);
        let lang = self.lang;
        // ANIM-MIGRATE(setup card morph between steps): requires measured surface edges and
        // retained old content; motion Props cannot animate layout bounds without scaling text.
        // ANIM-MIGRATE(first-install ink intro): requires the wallpaper's ink timeline and mark
        // reveal; motion Props animate painted groups, not the procedural ink or its keep-out.
        let mut shell = SetupWizardShell::new("first-run", words(lang).product)
            .variant(SetupWizardVariant::Focus)
            .anchor(SetupWizardAnchor::Top)
            .tone(self.tone(window))
            .intro(self.intro)
            .step_key(key)
            .child(body);
        if !matches!(Platform::host(), Platform::Mac) {
            shell = shell.window_controls(crate::ui::shell::window_controls(lang));
        }
        crate::ui::widgets::anchor(div(), "first-run-setup")
            .size_full()
            .child(shell)
    }
}
