//! Shell-owned browser tabs, address policy and page engine boundary.
use gpui::BorrowAppContext as _;
use gpui::{ElementId, SharedString, div, prelude::*};

use crate::ui::i18n::{browser::BrowserStrings, browser_handoff::BrowserHandoff};
use butler_ds::ui::blocks::composer_decision_panel::Media;
use butler_ds::ui::media_frame::{Aspect, MediaFrame};

pub(crate) mod address;
mod agent_host;
pub(crate) mod area;
mod bookmarks;
#[cfg(feature = "cef")]
mod cef;
mod dialog;
#[cfg(feature = "cef")]
pub(crate) mod downloads;
pub(crate) mod engine;
mod holder_band;
mod host;
mod lazy;
pub(crate) mod model;
mod new_tab;
mod page_commands;
mod page_dialog;
pub(crate) mod pick;
mod placeholder;
#[cfg(feature = "cef")]
mod popup_policy;
mod popup_window;
mod popups;
#[cfg(feature = "cef")]
pub(crate) mod print;
pub(crate) mod restore;
pub(crate) mod shell_state;
pub(crate) mod split_width;
mod suggestions;
mod tabs;
mod toolbar;
pub(crate) mod transfer;
mod visits;

/// The browser and the Agent's page host, for the life of the App (no window needed); the page
/// engine starts on its first use.
pub(crate) fn init(cx: &mut gpui::App) {
    if cx.has_global::<model::BrowserState>() {
        return;
    }
    visits::init(cx);
    restore::init(cx);
    split_width::init(cx);
    model::BrowserState::init(cx);
    cx.set_global(shell_state::BrowserShell::default());
}

/// The App is quitting: the engine closes its pages and flushes the profile.
pub(crate) fn shutdown(cx: &mut gpui::App) {
    if cx.has_global::<model::BrowserState>() {
        cx.update_global::<model::BrowserState, _>(|model, _| model.shutdown());
    }
}

/// A quitting process never drops the engine (AppKit `terminate:` exits without dropping globals),
/// and dropping it would shut CEF down and hide a missing quit hook. The shot harness returns
/// normally instead of exiting, so it leaks one strong reference to keep that behaviour.
#[cfg(all(feature = "cef", feature = "shots"))]
pub(crate) fn keep_runtime_alive(cx: &gpui::App) {
    if cx.has_global::<downloads::DownloadsRuntime>() {
        std::mem::forget(cx.global::<downloads::DownloadsRuntime>().0.clone());
    }
}

/// `window` is the shell's main window, whose renderer already exists. Its GPU adapter is where
/// page frames are consumed: gpui draws all windows, popups included, with one shared device, so
/// the page engine produces its frames on that adapter (shared GPU resources cannot cross one).
pub(crate) fn init_window(window: &gpui::Window, cx: &mut gpui::App) {
    init(cx);
    cx.global_mut::<model::BrowserState>()
        .note_adapter(window.gpu_adapter_luid());
}

/// Electron's `openLink`: a user-owned tab in the standalone browser.
pub(crate) fn open_link(url: &str, cx: &mut gpui::App) {
    if !url::Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "http" | "https")) {
        cx.open_url(url);
        return;
    }
    let value = cx.update_global::<model::BrowserState, _>(|model, cx| {
        model.create(model::Owner::Mine, Some(url), false, true, cx)
    });
    area::result(&value, cx);
    if value.is_ok()
        && let Some(ctx) = crate::ui::manage::window_ctx(cx)
    {
        ctx.set_view(crate::ui::manage::View::Browser, cx);
    }
}

/// Message links stay with a conversation that is present in navigation.
pub(crate) fn open_conversation_link(session: Option<&str>, url: &str, cx: &mut gpui::App) {
    let session = session.filter(|session| area::title(session, cx).is_some());
    if let Some(session) = session
        .filter(|_| url::Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "http" | "https")))
    {
        let value = cx.update_global::<model::BrowserState, _>(|model, cx| {
            model.create(
                model::Owner::Conversation(session.to_owned().into()),
                Some(url),
                false,
                true,
                cx,
            )
        });
        area::result(&value, cx);
        if let Ok(Some(id)) = value {
            open_tab(session, id, cx);
        }
    } else {
        // `openConversationLink` without a public conversation is `openLink`.
        open_link(url, cx);
    }
}

/// Electron `openHandoffTab`: the conversation's hosted tab at a human step, else one the Agent
/// waits on, else its first hosted tab.
pub(crate) fn handoff_tab(session: &str, cx: &gpui::App) -> Option<engine::TabId> {
    let owner = model::Owner::Conversation(session.to_owned().into());
    let hosted: Vec<_> = (cx.try_global::<model::BrowserState>()?.tabs().iter())
        .filter(|tab| tab.owner == owner)
        .filter_map(|tab| Some((&tab.id, tab.hosted.as_ref()?)))
        .collect();
    (hosted.iter().find(|(_, hosted)| hosted.step.is_some()))
        .or_else(|| hosted.iter().find(|(_, hosted)| hosted.waiting))
        .or(hosted.first())
        .map(|(id, _)| (*id).clone())
}

pub(crate) fn handoff_media(
    session: &str,
    tab: &str,
    window: &mut gpui::Window,
    cx: &mut gpui::App,
) -> Option<Media> {
    let owner = model::Owner::Conversation(session.to_owned().into());
    let state = cx.try_global::<model::BrowserState>()?;
    let tab = state
        .tabs()
        .iter()
        .find(|item| item.id.0.as_ref() == tab && item.owner == owner)?
        .clone();
    let id = tab.id.clone();
    let thumb =
        cx.update_global::<model::BrowserState, _>(|s, cx| s.engine.thumbnail(&id, window, cx));
    let mut placeholder = MediaFrame::new((ElementId::Name(tab.id.0.clone()), "handoff-frame"))
        .aspect(Aspect::SixteenTen)
        .placeholder();
    if !tab.favicon.is_empty() {
        placeholder = placeholder.placeholder_icon(SharedString::from(tab.favicon.clone()));
    }
    let content = div()
        .relative()
        .w_full()
        .aspect_ratio(16. / 10.)
        .child(placeholder)
        .children(thumb);
    let title = if tab.title.is_empty() {
        BrowserStrings::get(cx).new_tab
    } else {
        &tab.title
    };
    let label = format!("{} · {title}", BrowserHandoff::get(cx).open_tab);
    let session = session.to_owned();
    let tab = tab.id.clone();
    Some(Media::new(content, label).on_open(move |_, _, cx| {
        open_tab(&session, tab.clone(), cx);
    }))
}

/// Electron `openHandoffTab`: the conversation's browser on its hand-off tab, else the
/// conversation itself.
pub(crate) fn open_handoff(session: &str, cx: &mut gpui::App) {
    match handoff_tab(session, cx) {
        Some(tab) => open_tab(session, tab, cx),
        None => shell_state::open_conversation(session, cx),
    }
}

/// Opens the conversation's browser on `tab`.
pub(crate) fn open_tab(session: &str, tab: engine::TabId, cx: &mut gpui::App) {
    cx.global_mut::<shell_state::BrowserShell>()
        .remember_tab(session, tab);
    shell_state::open_conversation(session, cx);
}
