//! The window: AdaptiveShell frame="cards" (AdaptiveShellCards.module.css, AdaptiveShellFrame):
//! the sidebar track, the chat card with the floating composer, the title row, and the
//! suggest-a-change dialog when one is open.
mod data;
mod modify;
mod render;
mod titlebar;

use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{
    AppContext as _, Bounds, Context, Entity, FocusHandle, KeyBinding, Pixels, SharedString,
    Subscription, Window, WindowAppearance, actions,
};

use crate::ui::chat::{Chat, LoadOlder};
use crate::ui::composer::{Composer, ComposerEvent};
use crate::ui::dialog::Dialog;
use crate::ui::i18n::Locale;
use crate::ui::motion::Hover;
use crate::ui::sidebar::SidebarState;
use crate::ui::source::Source;
use crate::ui::store::Store;
use crate::ui::theme::Theme;
use crate::ui::widgets::HasHover;

actions!(shell, [ToggleTheme, ToggleSidebar, Quit]);

pub(crate) fn bindings() -> Vec<KeyBinding> {
    vec![
        KeyBinding::new("secondary-shift-l", ToggleTheme, None),
        KeyBinding::new("secondary-shift-s", ToggleSidebar, None),
        KeyBinding::new("secondary-q", Quit, None),
    ]
}

/// How often relative ages ("12분") are redrawn.
const AGE_TICK: Duration = Duration::from_secs(30);

pub(crate) struct Shell {
    pub(crate) theme: Theme,
    pub(crate) chat: Entity<Chat>,
    pub(crate) composer: Entity<Composer>,
    pub(crate) dialog: Option<Entity<Dialog>>,
    pub(crate) hover: Hover,
    pub(crate) sidebar: SidebarState,
    sidebar_open: bool,
    /// The agent, while one is attached; `None` shows the disconnected state.
    source: Option<Rc<dyn Source>>,
    incompatible: bool,
    pub(crate) store: Store,
    /// A brief notice (a failed request), and when it appeared.
    toast: Option<(SharedString, Instant)>,
    /// The native acrylic is under the window (else the shell paints an opaque fallback).
    acrylic: bool,
    theme_override: Option<bool>,
    /// The composer card's measured height (the conversation keeps room for it).
    composer_h: Rc<Cell<f32>>,
    card_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    focus: FocusHandle,
    subscriptions: Vec<Subscription>,
    live_task: Option<gpui::Task<()>>,
    connection_task: Option<gpui::Task<()>>,
    rediscover: Option<tokio::sync::mpsc::UnboundedSender<()>>,
}

impl HasHover for Shell {
    fn hover_state(&mut self) -> &mut Hover {
        &mut self.hover
    }
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
    /// The native acrylic is under the window.
    pub(crate) acrylic: bool,
    /// Light or dark regardless of the system (`None`: follow it).
    pub(crate) dark: Option<bool>,
    pub(crate) code_font: SharedString,
    pub(crate) locale: Locale,
}

impl Shell {
    pub(crate) fn new(options: ShellOptions, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let dark = options.dark.unwrap_or_else(|| system_dark(window));
        let theme = Theme::new(dark, options.code_font, options.locale.strings());
        let chat = cx.new(|_| Chat::new(theme.clone()));
        let composer = cx.new(|cx| Composer::new(theme.clone(), window, cx));
        let focus = cx.focus_handle();
        let subscriptions = vec![
            cx.subscribe_in(&composer, window, Self::on_composer),
            cx.subscribe(&chat, |this: &mut Self, _, e: &LoadOlder, cx| {
                this.load_older(e, cx);
            }),
        ];
        let composer_h = composer.read(cx).height_cell();
        cx.set_window_appearance(options.dark.map(appearance));
        let mut shell = Self {
            theme,
            chat,
            composer,
            dialog: None,
            hover: Hover::default(),
            sidebar: SidebarState::new(),
            sidebar_open: true,
            source: options.source,
            incompatible: false,
            store: Store::default(),
            toast: None,
            acrylic: options.acrylic,
            theme_override: options.dark,
            composer_h,
            card_bounds: Rc::new(Cell::new(None)),
            focus,
            subscriptions,
            live_task: None,
            connection_task: None,
            rediscover: None,
        };
        shell.sync_composer(cx);
        shell.connect(cx);
        Self::tick_ages(cx);
        shell
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

    /// Redraws relative ages while chats are listed.
    fn tick_ages(cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(AGE_TICK).await;
                let alive = this.update(cx, |this, cx| {
                    if !this.store.chats.is_empty() {
                        cx.notify();
                    }
                });
                if alive.is_err() {
                    return;
                }
            }
        })
        .detach();
    }

    fn set_dark(&mut self, dark: bool, cx: &mut Context<Self>) {
        if self.theme.dark == dark {
            return;
        }
        self.theme = Theme::new(dark, self.theme.code_font.clone(), self.theme.strings);
        let t = self.theme.clone();
        self.chat.update(cx, |c, cx| {
            c.theme = t.clone();
            cx.notify();
        });
        self.composer.update(cx, |c, cx| {
            c.set_theme(t.clone(), cx);
            cx.notify();
        });
        if let Some(dialog) = &self.dialog {
            dialog.update(cx, |d, cx| {
                d.theme = t;
                cx.notify();
            });
        }
        cx.notify();
    }

    fn toggle_theme(&mut self, _: &ToggleTheme, _: &mut Window, cx: &mut Context<Self>) {
        let dark = !self.theme.dark;
        self.theme_override = Some(dark);
        // The window frame and the acrylic follow the chosen theme, not the system's.
        cx.set_window_appearance(Some(appearance(dark)));
        self.set_dark(dark, cx);
    }

    fn toggle_sidebar(&mut self, _: &ToggleSidebar, _: &mut Window, cx: &mut Context<Self>) {
        self.sidebar_open = !self.sidebar_open;
        cx.notify();
    }

    fn on_composer(
        &mut self,
        _: &Entity<Composer>,
        event: &ComposerEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            ComposerEvent::Send(text) => self.send(text.to_string(), cx),
            ComposerEvent::Stop => self.stop(cx),
            ComposerEvent::Answer(request, decision) => self.answer(request, decision.clone(), cx),
            ComposerEvent::Modify(card) => self.open_modify(card, window, cx),
        }
    }
}
