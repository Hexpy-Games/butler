//! Conversation browser placement and its titlebar toggle.
use super::Shell;
use crate::ui::{
    Icon,
    browser::{
        area::browser_area,
        model::BrowserState,
        shell_state::{BrowserShell, browser_raise, open_conversation},
    },
    i18n::browser::BrowserStrings,
    viewer,
    widgets::anchor,
};
use butler_ds::ui::icon_button::{IconButton, Pane};
use gpui::{AnyElement, Context, Window, div, prelude::*};
impl Shell {
    fn browser_owner(&self, cx: &gpui::App) -> Option<crate::ui::browser::model::Owner> {
        use crate::ui::{browser::model::Owner, manage::View};
        if self.settings_view.is_some() {
            return None;
        }
        if self.view(cx) == View::Browser {
            return Some(Owner::Mine);
        }
        let session = self.store.selected()?.session.0.clone();
        let files = viewer::session_files(cx, &session);
        (self.on_session(cx)
            && viewer::right_slot_pane(browser_raise(&session, cx), &files)
                == Some(viewer::RightSlotPane::Browser))
        .then_some(Owner::Conversation(session))
    }
    pub(super) fn browser_focus_address(
        &mut self,
        _: &crate::ui::browser::area::FocusAddress,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(owner) = self.browser_owner(cx) {
            crate::ui::browser::area::focus_address(owner, cx);
        } else {
            cx.propagate();
        }
    }
    pub(super) fn browser_new_tab(
        &mut self,
        _: &crate::ui::browser::area::NewTab,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(owner) = self.browser_owner(cx) {
            crate::ui::browser::area::create(owner, cx);
        } else {
            cx.propagate();
        }
    }
    pub(super) fn browser_close_tab(
        &mut self,
        _: &crate::ui::browser::area::CloseTab,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.browser_owner(cx).is_none() {
            cx.propagate();
            return;
        }
        if let Some(id) = cx.global::<BrowserState>().active().cloned() {
            cx.global_mut::<BrowserState>().close(&id);
            cx.refresh_windows();
        }
    }
    pub(super) fn browser_back(
        &mut self,
        _: &crate::ui::browser::area::Back,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.browser_navigate(false, cx);
    }
    pub(super) fn browser_forward(
        &mut self,
        _: &crate::ui::browser::area::Forward,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.browser_navigate(true, cx);
    }
    fn browser_navigate(&self, forward: bool, cx: &mut Context<Self>) {
        if self.browser_owner(cx).is_none() {
            cx.propagate();
            return;
        }
        if let Some(id) = cx.global::<BrowserState>().active().cloned() {
            let model = cx.global_mut::<BrowserState>();
            let value = if forward {
                model.forward(&id)
            } else {
                model.back(&id)
            };
            crate::ui::browser::area::result(&value, cx);
        }
    }
    pub(super) fn render_browser_pane(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let session = self.store.selected().map(|c| c.session.0.to_string());
        browser_area(session.as_deref(), window, cx)
    }
    pub(super) fn browser_toggle(&self, cx: &Context<Self>) -> Option<AnyElement> {
        let session = self.store.selected()?.session.0.to_string();
        let files = viewer::session_files(cx, &session);
        let open = viewer::right_slot_pane(browser_raise(&session, cx), &files)
            == Some(viewer::RightSlotPane::Browser);
        let c = BrowserStrings::get(cx);
        let mut button = IconButton::new(
            "titlebar-browser-toggle",
            if open { c.hide } else { c.show },
        )
        .glyph(Icon::Globe2)
        .pane(Pane::Browser)
        .pressed(open)
        .on_click(move |_, _, cx| {
            if open {
                cx.global_mut::<BrowserShell>().set_open(&session, false);
                cx.refresh_windows();
            } else {
                open_conversation(&session, cx);
            }
        });
        if !cx.global::<BrowserState>().enabled() {
            button = button.disabled();
        }
        Some(
            anchor(div(), "titlebar-browser-toggle")
                .flex()
                .flex_none()
                .child(button)
                .into_any_element(),
        )
    }
}
