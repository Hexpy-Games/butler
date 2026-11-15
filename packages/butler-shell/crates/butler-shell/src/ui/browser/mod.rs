//! Shell-owned browser tabs, address policy and page engine boundary.
pub(crate) mod address;
pub(crate) mod area;
mod bookmarks;
pub(crate) mod engine;
pub(crate) mod model;
mod placeholder;
pub(crate) mod shell_state;
mod tabs;
mod toolbar;

pub(crate) fn init(cx: &mut gpui::App) {
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
    let session = session.filter(|session| area::title(session, cx).is_some());
    if let Some(session) = session
        .filter(|_| url::Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "http" | "https")))
    {
        let value = cx.global_mut::<model::BrowserState>().create(
            model::Owner::Conversation(session.to_owned().into()),
            Some(url),
            false,
        );
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
