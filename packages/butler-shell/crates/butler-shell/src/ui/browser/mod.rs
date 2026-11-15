//! Shell-owned browser tabs, address policy and page engine boundary.
pub(crate) mod address;
pub(crate) mod area;
mod bookmarks;
#[cfg(feature = "cef")]
mod cef;
mod dialog;
#[cfg(feature = "cef")]
pub(crate) mod downloads;
pub(crate) mod embed;
pub(crate) mod engine;
mod host;
pub(crate) mod html;
pub(crate) mod model;
mod page_dialog;
pub(crate) mod pick;
mod placeholder;
#[cfg(feature = "cef")]
mod popup_policy;
mod popup_window;
mod popups;
#[cfg(feature = "cef")]
pub(crate) mod printing;
pub(crate) mod shell_state;
mod tabs;
mod toolbar;
pub(crate) mod transfer;

pub(crate) fn init(cx: &mut gpui::App) {
    if cx.has_global::<model::BrowserState>() {
        return;
    }
    model::BrowserState::init(cx);
    cx.set_global(shell_state::BrowserShell::default());
}

/// Electron's `openLink`: a user-owned tab in the standalone browser.
pub(crate) fn open_link(url: &str, cx: &mut gpui::App) {
    if !url::Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "http" | "https")) {
        cx.open_url(url);
        return;
    }
    let value = cx
        .global_mut::<model::BrowserState>()
        .create(model::Owner::Mine, Some(url), false);
    area::result(&value, cx);
    if value.is_ok()
        && let Some(ctx) = crate::ui::manage::window_ctx(cx)
    {
        ctx.set_view(crate::ui::manage::View::Browser, cx);
    }
}

/// Message links stay with a conversation that is present in navigation.
pub(crate) fn open_conversation_link(session: Option<&str>, url: &str, cx: &mut gpui::App) {
    if session.is_some_and(|id| area::title(id, cx).is_some()) && address::web_url(url).is_some() {
        open_output_in_browser(session, url, None, cx);
    } else {
        open_link(url, cx);
    }
}

pub(crate) fn open_output_in_browser(
    session: Option<&str>,
    url: &str,
    preview: Option<&str>,
    cx: &mut gpui::App,
) {
    let session = session.filter(|session| area::title(session, cx).is_some());
    if let Some(session) = session
        .filter(|_| url::Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "http" | "https")))
    {
        let value = cx.global_mut::<model::BrowserState>().create_view(
            model::Owner::Conversation(session.to_owned().into()),
            Some(url),
            false,
            preview,
        );
        area::result(&value, cx);
        if let Ok(Some(id)) = value {
            cx.global_mut::<shell_state::BrowserShell>()
                .remember_tab(session, id);
            shell_state::open_conversation(session, cx);
        }
    }
}
