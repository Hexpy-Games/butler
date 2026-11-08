//! The App's tray (`main.mjs:1490-1620`, `tray-agent-menu.mjs`, foreground mode): Open Butler,
//! the Agent status, Restart, Start at login, New Chat, Recent Conversations and Quit.
//!
//! The tray only reacts. The menu is rebuilt when something it shows changed (the Agent state,
//! the recent conversations a window already loaded, the language, the system theme, the login
//! item) and the OS reports clicks on a channel; no timer, no poll, no request of its own.
mod copy;

use std::ffi::OsString;

use butler_platform::login_item::{self, LoginItem};
use butler_platform::tray::{self as platform, Tray, TrayEvent, TrayIcon, TrayItem};
use gpui::{App, AppContext as _, Context, Entity, Global, Task, WindowAppearance};

use super::supervisor::{AgentState, Supervisor};
use super::window;
use crate::ui::i18n::Locale;
use crate::ui::shell::Shell;
use crate::ui::shell::navigation::Navigation;
use copy::Words;

/// `butler-mark-flat.png` (light theme) and `butler-mark-flat-white.png` (dark theme).
const MARK_BLACK: &[u8] = include_bytes!("../../../butler-ds/assets/brand/butler-mark.png");
const MARK_WHITE: &[u8] = include_bytes!("../../../butler-ds/assets/brand/butler-mark-white.png");

/// How many conversations the submenu lists (`recentTraySessions`).
const RECENT: usize = 6;

const OPEN: &str = "open";
const RESTART: &str = "restart";
const LOGIN: &str = "login";
const NEW_CHAT: &str = "new-chat";
const SESSION: &str = "session:";
const QUIT: &str = "quit";

#[derive(Clone, PartialEq)]
struct Recent {
    id: String,
    title: String,
}

/// Everything the menu and the icon are drawn from; the OS is touched only when it changes.
#[derive(PartialEq)]
struct Look {
    dark: bool,
    locale: Locale,
    state: AgentState,
    login: LoginItem,
    recents: Vec<Recent>,
}

struct TrayModel {
    tray: Option<Tray>,
    /// The OS refused the icon; no new attempt.
    failed: bool,
    shown: Option<Look>,
    dark: bool,
    locale: Locale,
    recents: Vec<Recent>,
    events: Option<Task<()>>,
}

struct GlobalTray(Entity<TrayModel>);

impl Global for GlobalTray {}

fn model(cx: &App) -> Option<Entity<TrayModel>> {
    cx.try_global::<GlobalTray>().map(|global| global.0.clone())
}

fn system_dark(cx: &App) -> bool {
    matches!(
        cx.window_appearance(),
        WindowAppearance::Dark | WindowAppearance::VibrantDark
    )
}

fn executable_login() -> LoginItem {
    std::env::current_exe().map_or(LoginItem::Unavailable, |exe| login_item::status(&exe))
}

/// `trayAgentServiceLabel` over the App's `AgentState`.
fn status_label(state: AgentState, words: &Words) -> &'static str {
    match state {
        AgentState::Running => words.running,
        AgentState::Starting => words.starting,
        // `diagnostics().phase` "idle" falls to the label's default (tray-agent-menu.mjs).
        AgentState::Idle => words.not_installed,
        AgentState::Restarting => words.updating,
        AgentState::Stopped => words.stopped,
        AgentState::Failed | AgentState::RestartFailed => words.failed,
    }
}

/// `createTrayAgentMenuModel`.canRestart: ready, failed or stopped.
fn can_restart(state: AgentState) -> bool {
    matches!(
        state,
        AgentState::Running | AgentState::Failed | AgentState::RestartFailed | AgentState::Stopped
    )
}

fn action(id: &str, label: &str, enabled: bool) -> TrayItem {
    TrayItem::Action {
        id: id.to_owned(),
        label: label.to_owned(),
        enabled,
    }
}

fn menu(look: &Look, words: &Words) -> Vec<TrayItem> {
    let recent = if look.recents.is_empty() {
        vec![TrayItem::Label(words.none.to_owned())]
    } else {
        look.recents
            .iter()
            .map(|chat| {
                let title = chat.title.trim();
                let title = if title.is_empty() {
                    words.untitled
                } else {
                    title
                };
                action(&format!("{SESSION}{}", chat.id), title, true)
            })
            .collect()
    };
    let mut items = vec![
        action(OPEN, words.open, true),
        TrayItem::Label(status_label(look.state, words).to_owned()),
        action(RESTART, words.restart, can_restart(look.state)),
    ];
    if look.login != LoginItem::Unavailable {
        items.push(TrayItem::Check {
            id: LOGIN.to_owned(),
            label: words.login.to_owned(),
            checked: look.login == LoginItem::On,
        });
    }
    items.extend([
        TrayItem::Separator,
        action(NEW_CHAT, words.new_chat, true),
        TrayItem::Submenu {
            label: words.recent.to_owned(),
            items: recent,
        },
        TrayItem::Separator,
        action(QUIT, words.quit, true),
    ]);
    items
}

fn mark(dark: bool) -> TrayIcon<'static> {
    TrayIcon {
        png: if dark { MARK_WHITE } else { MARK_BLACK },
    }
}

impl TrayModel {
    fn look(&self, cx: &Context<Self>) -> Option<Look> {
        let runtime = super::runtime(cx)?;
        Some(Look {
            dark: self.dark,
            locale: self.locale,
            state: runtime.read(cx).state,
            login: executable_login(),
            recents: self.recents.clone(),
        })
    }

    /// Brings the OS icon and menu in line with the App, touching the OS only for a change.
    fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.failed {
            return;
        }
        let Some(look) = self.look(cx) else {
            return;
        };
        if self.shown.as_ref() == Some(&look) {
            return;
        }
        let words = copy::words(look.locale);
        let items = menu(&look, words);
        match &self.tray {
            Some(tray) => {
                tray.set_menu(&items);
                if self
                    .shown
                    .as_ref()
                    .is_some_and(|shown| shown.dark != look.dark)
                {
                    tray.set_icon(mark(look.dark));
                }
            }
            None => self.show(&look, &items, words, cx),
        }
        self.shown = Some(look);
    }

    fn show(&mut self, look: &Look, items: &[TrayItem], words: &Words, cx: &mut Context<Self>) {
        let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
        match platform::create(mark(look.dark), words.tooltip, items, sender) {
            Ok(tray) => {
                self.tray = Some(tray);
                self.events = Some(cx.spawn(async move |_, cx| {
                    while let Some(event) = events.recv().await {
                        cx.update(|cx| handle(event, cx));
                    }
                }));
            }
            Err(error) => {
                self.failed = true;
                eprintln!("butler-shell: no tray icon ({error:?})");
            }
        }
    }

    /// A window's conversations, language or the system theme moved.
    fn shell_changed(&mut self, shell: &Entity<Shell>, cx: &mut Context<Self>) {
        let shell = shell.read(cx);
        let locale = shell.theme.strings.locale;
        let dark = system_dark(cx);
        let recents = shell.store.navigation.view.as_ref().map(|view| {
            view.chats
                .iter()
                .filter(|chat| !chat.id.trim().is_empty())
                .take(RECENT)
                .map(|chat| Recent {
                    id: chat.id.clone(),
                    title: chat.title.clone(),
                })
                .collect::<Vec<_>>()
        });
        let recents = recents.unwrap_or_else(|| self.recents.clone());
        if (locale, dark, &recents) == (self.locale, self.dark, &self.recents) {
            return;
        }
        (self.locale, self.dark, self.recents) = (locale, dark, recents);
        self.refresh(cx);
    }
}

/// A choice in the menu or a double click.
fn handle(event: TrayEvent, cx: &mut App) {
    let TrayEvent::Item(id) = event else {
        window::reopen(cx);
        return;
    };
    match id.as_str() {
        OPEN => window::reopen(cx),
        RESTART => super::command(cx, Supervisor::restart),
        LOGIN => {
            if let Ok(exe) = std::env::current_exe() {
                let on = login_item::status(&exe) == LoginItem::On;
                let _ = login_item::set(&exe, !on);
            }
            refresh(cx);
        }
        NEW_CHAT => navigate("--butler-new-chat".to_owned(), cx),
        QUIT => super::quit(cx),
        other => {
            if let Some(session) = other.strip_prefix(SESSION) {
                navigate(format!("--butler-open-session={session}"), cx);
            }
        }
    }
}

/// New Chat or a recent conversation: in the open window, else in a new one.
fn navigate(arg: String, cx: &mut App) {
    let Some(request) = Navigation::from_args(std::slice::from_ref(&arg)) else {
        return;
    };
    let shell = cx
        .windows()
        .into_iter()
        .find_map(|handle| handle.downcast::<Shell>());
    let Some(shell) = shell else {
        if let Err(error) = window::open_window(cx, &[OsString::from(arg)]) {
            eprintln!("butler-shell: {error:#}");
        }
        return;
    };
    let _ = shell.update(cx, |view, window, cx| {
        view.navigate(request, window, cx);
        window.activate();
    });
}

/// Shows the tray. In foreground mode Electron keeps it on whatever `desktop_tray_enabled`
/// says (`main.mjs:1419-1420, 2542-2543`), so the setting is not read.
pub(crate) fn init(cx: &mut App) {
    let locale = Locale::from_tag(&sys_locale::get_locale().unwrap_or_default());
    let dark = system_dark(cx);
    let entity = cx.new(|_| TrayModel {
        tray: None,
        failed: false,
        shown: None,
        dark,
        locale,
        recents: Vec::new(),
        events: None,
    });
    cx.set_global(GlobalTray(entity.clone()));
    if let Some(runtime) = super::runtime(cx) {
        entity.update(cx, |_, cx| {
            cx.observe(&runtime, |tray, _, cx| tray.refresh(cx))
                .detach();
        });
    }
    // Each window tells the tray what it already loaded; the tray asks the Agent for nothing.
    let weak = entity.downgrade();
    cx.observe_new(move |_: &mut Shell, _, cx: &mut Context<Shell>| {
        let (Some(tray), shell) = (weak.upgrade(), cx.entity()) else {
            return;
        };
        tray.update(cx, |_, cx| {
            cx.observe(&shell, |tray, shell, cx| tray.shell_changed(&shell, cx))
                .detach();
        });
    })
    .detach();
    entity.update(cx, TrayModel::refresh);
}

/// The login item changed outside the tray (Settings → Start at login): redraw its check.
pub(crate) fn refresh(cx: &mut App) {
    if let Some(entity) = model(cx) {
        entity.update(cx, TrayModel::refresh);
    }
}

/// Whether the tray is shown; closing the last window keeps the App running only then.
pub(crate) fn active(cx: &App) -> bool {
    model(cx).is_some_and(|entity| entity.read(cx).tray.is_some())
}
