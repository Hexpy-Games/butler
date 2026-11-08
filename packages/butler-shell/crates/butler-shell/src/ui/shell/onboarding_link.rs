//! The shell's side of the onboarding (`AppOnboardingShell`, `useFirstRunLanding`): which mode
//! shows, the setup screen as the window's only child, and what its events change.
use std::rc::Rc;

use blocks::adaptive_shell::AdaptiveShell;
use blocks::{responsive::ChromeEnvironment, scope::ShellFrame};
use butler_ds::ui::blocks;
use butler_ds::ui::context::Lang;
use gpui::{AnyElement, AppContext as _, Context, Entity, IntoElement as _, Window};

use super::Shell;
use super::navigation::Navigation;
use crate::ui::i18n::Locale;
use crate::ui::onboarding::gate::Gate;
use crate::ui::onboarding::{Mode, Onboarding, OnboardingEvent};

/// The window's onboarding: the gate (`useOnboardingGate`, resolved once from the first
/// `/settings`), Run setup again (`onboardingStore.rerunOpen`) and the setup view while it shows.
pub(super) struct OnboardingState {
    pub(super) gate: Gate,
    pub(super) rerun: bool,
    view: Option<Entity<Onboarding>>,
}

impl OnboardingState {
    /// A source handed in at construction (the shot harness's fixture) has no `/settings` to
    /// gate on; an attached agent's settings decide.
    pub(super) fn new(injected_source: bool) -> Self {
        Self {
            gate: if injected_source {
                Gate::Workspace
            } else {
                Gate::Pending
            },
            rerun: false,
            view: None,
        }
    }

    /// The setup shows: the gate is not the workspace, or Run setup again is open.
    pub(super) fn shows(&self) -> bool {
        self.gate != Gate::Pending && (self.gate != Gate::Workspace || self.rerun)
    }
}

impl Shell {
    /// Rerun from Settings, else a consent renewal, else the first run.
    fn onboarding_mode(&self) -> Mode {
        if self.onboarding.rerun {
            Mode::Rerun
        } else if self.onboarding.gate == Gate::Consent {
            Mode::Consent
        } else {
            Mode::FirstRun
        }
    }

    /// The onboarding for the current mode; a new mode builds a new one (React `key={mode}`).
    pub(super) fn onboarding_view(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<Onboarding> {
        let mode = self.onboarding_mode();
        if let Some(view) = &self.onboarding.view
            && view.read(cx).mode == mode
        {
            return view.clone();
        }
        let settings = self.settings_raw.clone().unwrap_or_default();
        let catalog = self.catalog_raw.clone().unwrap_or_default();
        let view = cx.new(|cx| Onboarding::new(mode, settings, catalog, window, cx));
        cx.subscribe_in(&view, window, Self::on_onboarding).detach();
        let lang = view.read(cx).lang;
        self.set_locale(locale(lang), cx);
        self.onboarding.view = Some(view.clone());
        view
    }

    /// `AppShell` with the setup screen as the shell's only child, as the settings screen.
    pub(super) fn onboarding_frame(&self, view: Entity<Onboarding>, window: &Window) -> AnyElement {
        let (input, platform) = self.shell_window(window);
        AdaptiveShell::new("app-frame", input)
            .frame(ShellFrame::Cards)
            .chrome_environment(ChromeEnvironment::Electron)
            .platform(platform)
            .settings_active(true)
            .settings(view)
            .into_any_element()
    }

    fn on_onboarding(
        &mut self,
        view: &Entity<Onboarding>,
        event: &OnboardingEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            OnboardingEvent::Complete(card) => {
                let settings: Rc<serde_json::Value> = view.read(cx).settings.clone();
                self.onboarding.gate = Gate::Workspace;
                self.onboarding.rerun = false;
                self.onboarding.view = None;
                self.apply_settings(&settings, cx);
                if card.is_some() {
                    self.navigate(Navigation::NewChat, window, cx);
                }
            }
            OnboardingEvent::Cancel => {
                self.onboarding.rerun = false;
                self.onboarding.view = None;
            }
            OnboardingEvent::Language(lang) => self.set_locale(locale(*lang), cx),
        }
        cx.notify();
    }
}

fn locale(lang: Lang) -> Locale {
    match lang {
        Lang::Ko => Locale::Ko,
        Lang::En => Locale::En,
    }
}
