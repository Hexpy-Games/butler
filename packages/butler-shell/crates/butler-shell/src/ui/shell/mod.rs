//! The window: AdaptiveShell frame="cards" (AdaptiveShellCards.module.css, AdaptiveShellFrame):
//! the sidebar track, the chat card with the floating composer, and the title row.
mod composer_link;
mod data;
mod frame;
pub(crate) mod image_viewer;
mod manage_link;
pub(crate) mod navigation;
mod notifications;
mod onboarding_link;
mod panes;
mod region;
mod render;
mod session_menu;
mod settings_link;
mod titlebar;
mod transcript;

pub(crate) use titlebar::window_controls;

use std::cell::Cell;
use std::rc::Rc;

use gpui::{
    AppContext as _, Context, Entity, FocusHandle, KeyBinding, SharedString, Subscription, Window,
    WindowAppearance, actions,
};

use crate::ui::chat::Chat;
use crate::ui::composer::Composer;
use crate::ui::i18n::Locale;
use crate::ui::sidebar::SidebarState;
use crate::ui::source::Source;
use crate::ui::store::Store;
use crate::ui::theme::Theme;

actions!(
    shell,
    [
        ToggleSidebar,
        FocusComposer,
        TextSizeUp,
        TextSizeDown,
        TextSizeReset,
        TogglePalette,
        TitlebarBack,
        Quit
    ]
);

pub(crate) fn bindings() -> Vec<KeyBinding> {
    vec![
        KeyBinding::new("secondary-shift-e", FocusComposer, None),
        KeyBinding::new("secondary-=", TextSizeUp, None),
        KeyBinding::new("secondary-+", TextSizeUp, None),
        KeyBinding::new("secondary--", TextSizeDown, None),
        KeyBinding::new("secondary-0", TextSizeReset, None),
        KeyBinding::new("secondary-q", Quit, None),
        KeyBinding::new("secondary-k", TogglePalette, None),
        // `useTitlebarBack`: mod+[ anywhere, alt+← outside a text field.
        KeyBinding::new("secondary-[", TitlebarBack, None),
        KeyBinding::new("alt-left", TitlebarBack, Some("!EditableText")),
    ]
}

pub(crate) struct Shell {
    pub(crate) theme: Theme,
    pub(crate) chat: Entity<Chat>,
    pub(crate) composer: Entity<Composer>,
    pub(crate) sidebar: SidebarState,
    pub(super) sidebar_open: bool,
    frame: frame::FrameState,
    pending_navigation: Option<navigation::Navigation>,
    /// A window title the next frame applies: the app title in a newly chosen language.
    pending_title: Option<&'static str>,
    attention: notifications::Attention,
    session_menu: session_menu::SessionMenu,
    /// The agent, while one is attached; `None` shows the disconnected state.
    pub(crate) source: Option<Rc<dyn Source>>,
    incompatible: bool,
    pub(crate) store: Store,
    theme_override: Option<bool>,
    /// The composer card's measured height (the conversation keeps room for it).
    composer_h: Rc<Cell<f32>>,
    panes: panes::Panes,
    /// The cached views the window is composed of.
    regions: region::Regions,
    focus: FocusHandle,
    _subscriptions: Vec<Subscription>,
    live_task: Option<gpui::Task<()>>,
    connection_task: Option<gpui::Task<()>>,
    rediscover: Option<tokio::sync::mpsc::UnboundedSender<crate::ui::source::agent::MonitorSignal>>,
    /// Whether the open chat's latest window is being read again.
    refresh: Refresh,
    /// The management view, its page, the observer and the live topics.
    manage: manage_link::Manage,
    /// The settings screen while it is open (it replaces the frame).
    settings_view: Option<Entity<crate::ui::settings::SettingsView>>,
    /// A settings page a hook without the window asked for; the next frame opens it.
    pending_settings: Option<String>,
    /// The last `/settings` (the store's `settings`); the settings screen opens with it.
    settings_raw: Option<Rc<serde_json::Value>>,
    /// Light or dark is forced (`ShellOptions::dark`, the shot harness): the theme setting
    /// does not apply.
    forced_theme: bool,
    /// The onboarding gate, Run setup again and the setup view.
    onboarding: onboarding_link::OnboardingState,
    /// The last `/model-catalog`; the onboarding opens with it.
    catalog_raw: Option<Rc<serde_json::Value>>,
    /// The `/settings` and `/model-catalog` read, retried while the gate is pending.
    settings_task: Option<gpui::Task<()>>,
}

/// The open chat's refresh: idle, running, or running with another asked for meanwhile.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Refresh {
    Idle,
    Running,
    Again,
}

fn appearance(dark: bool) -> WindowAppearance {
    if dark {
        WindowAppearance::Dark
    } else {
        WindowAppearance::Light
    }
}

fn system_dark(window: &Window) -> bool {
    matches!(
        window.appearance(),
        WindowAppearance::Dark | WindowAppearance::VibrantDark
    )
}

/// How the shell starts.
pub(crate) struct ShellOptions {
    pub(crate) source: Option<Rc<dyn Source>>,
    /// Light or dark regardless of the system (`None`: follow it).
    pub(crate) dark: Option<bool>,
    pub(crate) code_font: gpui::Font,
    pub(crate) locale: Locale,
    pub(crate) platform: crate::ui::theme::Platform,
}

impl Shell {
    pub(crate) fn new(options: ShellOptions, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let dark = options.dark.unwrap_or_else(|| system_dark(window));
        Self::install_ds(&options, dark, window, cx);
        let theme = Theme::new(
            dark,
            options.platform,
            options.code_font,
            options.locale.strings(),
        );
        let chat = cx.new(|_| Chat::new());
        let composer = cx.new(|cx| Composer::new(theme.clone(), window, cx));
        let focus = cx.focus_handle();
        let mut subscriptions = Self::subscriptions(&composer, window, cx);
        let (panes, palette_events) = Self::new_panes(window, cx);
        subscriptions.push(palette_events);
        let (manage, manage_events) = Self::new_manage(window, cx);
        subscriptions.push(manage_events);
        let onboarding = onboarding_link::OnboardingState::new(options.source.is_some());
        let composer_h = composer.read(cx).height_cell();
        let regions = region::Regions::new(&cx.entity(), cx);
        cx.set_window_appearance(options.dark.map(appearance));
        let mut shell = Self {
            theme,
            chat,
            composer,
            sidebar: SidebarState::new(),
            sidebar_open: true,
            frame: frame::FrameState::default(),
            pending_navigation: None,
            pending_title: None,
            attention: notifications::Attention::default(),
            session_menu: session_menu::SessionMenu::default(),
            source: options.source,
            incompatible: false,
            store: Store::default(),
            theme_override: options.dark,
            composer_h,
            panes,
            regions,
            focus,
            _subscriptions: subscriptions,
            live_task: None,
            connection_task: None,
            rediscover: None,
            refresh: Refresh::Idle,
            manage,
            settings_view: None,
            pending_settings: None,
            settings_raw: None,
            forced_theme: options.dark.is_some(),
            onboarding,
            catalog_raw: None,
            settings_task: None,
        };
        Self::transcript_hooks(cx);
        Self::notification_responses(window, cx);
        Self::install_composer(&shell.manage_ctx(), cx);
        crate::ui::manage::library::detail::install(&shell.manage_ctx(), cx);
        let manage = shell.manage_ctx();
        shell
            .composer
            .update(cx, |composer, _| composer.manage = Some(manage.clone()));
        let weak = cx.entity().downgrade();
        crate::ui::inspector::install_epic_host(cx, manage, move |session, cx| {
            weak.upgrade()?.read(cx).sidebar.epic_of(session)
        });
        shell.sync_composer(cx);
        shell.connect(cx);
        shell
    }

    /// What the shell follows: the window's activation, the composer's events, the Agent
    /// runtime, and the App update (the update choice dialog and the sidebar's update row).
    fn subscriptions(
        composer: &Entity<Composer>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<Subscription> {
        let mut subscriptions = vec![
            cx.observe_window_activation(window, |this, window, cx| {
                this.sidebar.attended = window.is_window_active();
                this.sync_minute_clock(cx);
                if this.sidebar.attended
                    && let Some(id) = this.store.selected().map(|c| c.session.0.to_string())
                {
                    this.mark_sidebar_read(&id, cx);
                }
                cx.notify();
                if !window.is_window_active() {
                    butler_ds::ui::blocks::adaptive_shell::peek::window_blurred(window, cx);
                }
            }),
            cx.subscribe_in(composer, window, Self::on_composer),
        ];
        if let Some(runtime) = crate::lifecycle::runtime(cx) {
            subscriptions.push(cx.observe(&runtime, |_, _, cx| cx.notify()));
        }
        let update = crate::lifecycle::app_update::entity(cx);
        subscriptions.push(cx.observe(&update, |_, _, cx| cx.notify()));
        subscriptions
    }

    pub(crate) fn focus_handle(&self) -> FocusHandle {
        self.focus.clone()
    }

    /// Why the agent's controls are unavailable, when they are.
    pub(crate) fn disconnected(&self) -> Option<SharedString> {
        if self.incompatible {
            return Some(self.theme.strings.update_required.into());
        }
        self.source
            .is_none()
            .then(|| self.theme.strings.not_running.into())
    }

    fn set_dark(&mut self, dark: bool, cx: &mut Context<Self>) {
        if self.theme.dark == dark {
            return;
        }
        self.theme = Theme::new(
            dark,
            self.theme.platform,
            self.theme.code_font.clone(),
            self.theme.strings,
        );
        let t = self.theme.clone();
        self.composer.update(cx, |c, cx| {
            c.set_theme(t.clone(), cx);
            cx.notify();
        });
        cx.notify();
    }

    /// `setAppCopyLanguage`: the UI copy and the design system follow the app's language.
    pub(crate) fn set_locale(&mut self, locale: Locale, cx: &mut Context<Self>) {
        if self.theme.strings.locale == locale {
            return;
        }
        self.theme = Theme::new(
            self.theme.dark,
            self.theme.platform,
            self.theme.code_font.clone(),
            locale.strings(),
        );
        self.pending_title = Some(self.theme.strings.app_title);
        let lang = locale.ds_lang();
        butler_ds::ui::context::Ds::update(cx, |ds| ds.set_lang(lang));
        let t = self.theme.clone();
        self.composer.update(cx, |c, cx| {
            c.set_theme(t, cx);
            cx.notify();
        });
        cx.notify();
    }

    fn toggle_sidebar(&mut self, _: &ToggleSidebar, _: &mut Window, cx: &mut Context<Self>) {
        self.sidebar_open = !self.sidebar_open;
        cx.notify();
    }
}
