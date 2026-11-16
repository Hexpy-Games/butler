//! Shell-owned browser tabs, address policy and page engine boundary.
use gpui::BorrowAppContext as _;

pub(crate) mod address;
pub(crate) mod area;
mod bookmarks;
#[cfg(feature = "cef")]
mod cef;
mod dialog;
#[cfg(feature = "cef")]
pub(crate) mod downloads;
pub(crate) mod engine;
mod host;
pub(crate) mod model;
mod new_tab;
mod page_dialog;
pub(crate) mod pick;
mod placeholder;
#[cfg(feature = "cef")]
mod popup_policy;
mod popup_window;
mod popups;
pub(crate) mod restore;
pub(crate) mod shell_state;
mod suggestions;
mod tabs;
mod toolbar;
pub(crate) mod transfer;
mod visits;

/// `window` is the shell's main window, whose renderer already exists. Its GPU adapter is where
/// page frames are consumed: gpui draws all windows, popups included, with one shared device, so
/// the page engine produces its frames on that adapter (shared GPU resources cannot cross one).
pub(crate) fn init(window: &gpui::Window, cx: &mut gpui::App) {
    if cx.has_global::<model::BrowserState>() {
        return;
    }
    visits::init(cx);
    restore::init(cx);
    model::BrowserState::init(window.gpu_adapter_luid(), cx);
    cx.set_global(shell_state::BrowserShell::default());
}

/// The App is quitting: the engine closes its pages and flushes the profile.
pub(crate) fn shutdown(cx: &mut gpui::App) {
    if cx.has_global::<model::BrowserState>() {
        cx.update_global::<model::BrowserState, _>(|model, _| model.shutdown());
    }
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
            cx.global_mut::<shell_state::BrowserShell>()
                .remember_tab(session, id);
            shell_state::open_conversation(session, cx);
        }
    } else {
        // `openConversationLink` without a public conversation is `openLink`.
        open_link(url, cx);
    }
}
