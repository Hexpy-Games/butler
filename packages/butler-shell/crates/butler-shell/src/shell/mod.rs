//! The window: AdaptiveShell frame="cards" (AdaptiveShellCards.module.css, AdaptiveShellFrame):
//! the sidebar track, the chat card with the floating composer, the title row, and a dialog
//! when one is open.
mod data;
mod dialog_host;
mod render;
mod titlebar;

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Instant;

use gpui::{
    AppContext as _, Bounds, Context, Entity, FocusHandle, KeyBinding, Pixels, SharedString,
    Subscription, Window, WindowAppearance, actions,
};

use crate::chat::{Chat, LoadOlder};
use crate::composer::{Composer, ComposerEvent};
use crate::dialog::Dialog;
use crate::motion::Hover;
use crate::sidebar::SidebarState;
use crate::source::{AuthorityCard, ChatId, ChatSummary, PageCursor, Source, TurnId};
use crate::theme::Theme;
use crate::widgets::HasHover;

actions!(shell, [ToggleTheme, ToggleSidebar, Quit]);

pub(crate) fn bindings() -> Vec<KeyBinding> {
    vec![
        KeyBinding::new("secondary-shift-l", ToggleTheme, None),
        KeyBinding::new("secondary-shift-s", ToggleSidebar, None),
        KeyBinding::new("secondary-q", Quit, None),
    ]
}

/// Shown wherever the agent is needed while none is attached.
pub(crate) const NOT_RUNNING: &str = "버틀러가 실행 중이 아닙니다";

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
    /// The open chat (`None`: a new chat).
    selected: Option<ChatId>,
    /// Loaded chats in the agent's order, and where the next page starts.
    pub(crate) chats: Vec<ChatSummary>,
    pub(crate) chats_next: Option<PageCursor>,
    loading_chats: bool,
    running: HashMap<ChatId, TurnId>,
    authority: HashMap<ChatId, Vec<AuthorityCard>>,
    /// A brief notice (a failed request), and when it appeared.
    toast: Option<(SharedString, Instant)>,
    /// The native acrylic is under the window (else the shell paints an opaque fallback).
    acrylic: bool,
    theme_override: Option<bool>,
    composer_h: f32,
    card_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    focus: FocusHandle,
    subscriptions: Vec<Subscription>,
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
}

impl Shell {
    pub(crate) fn new(options: ShellOptions, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let dark = options.dark.unwrap_or_else(|| system_dark(window));
        let theme = Theme::new(dark, options.code_font);
        let chat = cx.new(|_| Chat::new(theme.clone()));
        let composer = cx.new(|cx| Composer::new(theme.clone(), window, cx));
        let focus = cx.focus_handle();
        let subs = vec![
            cx.subscribe_in(&composer, window, Self::on_composer),
            cx.subscribe(&chat, |this: &mut Self, _, e: &LoadOlder, cx| {
                this.load_older(e, cx);
            }),
        ];
        let disconnected = options
            .source
            .is_none()
            .then(|| SharedString::from(NOT_RUNNING));
        composer.update(cx, |c, _| {
            c.shell_focus = Some(focus.clone());
            c.disabled = disconnected;
            c.context = options.source.as_ref().map(|s| s.composer());
        });
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
            selected: None,
            chats: Vec::new(),
            chats_next: None,
            loading_chats: false,
            running: HashMap::new(),
            authority: HashMap::new(),
            toast: None,
            acrylic: options.acrylic,
            theme_override: options.dark,
            composer_h: 48.,
            card_bounds: Rc::new(Cell::new(None)),
            focus,
            subscriptions: subs,
        };
        shell.connect(cx);
        shell
    }

    pub(crate) fn focus_handle(&self) -> FocusHandle {
        self.focus.clone()
    }

    /// The open chat (`None`: a new chat).
    pub(crate) fn chat_selected(&self) -> Option<&ChatId> {
        self.selected.as_ref()
    }

    /// Why a new chat cannot start, when it cannot.
    pub(crate) fn new_chat_disabled(&self) -> Option<SharedString> {
        self.source.is_none().then(|| NOT_RUNNING.into())
    }

    fn set_dark(&mut self, dark: bool, cx: &mut Context<Self>) {
        if self.theme.dark == dark {
            return;
        }
        self.theme = Theme::new(dark, self.theme.code_font.clone());
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
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            ComposerEvent::Send(text) => self.send(text.to_string(), cx),
            ComposerEvent::Stop => self.stop(cx),
            ComposerEvent::Answer(request, decision) => self.answer(request, *decision, cx),
        }
    }
}
