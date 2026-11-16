//! The hub's conversation action and the conversation strip's bring-tab action.
use super::{
    area::{result, title},
    engine::TabId,
    model::{BrowserState, Owner},
    shell_state::{BrowserShell, open_conversation},
};
use crate::ui::{
    Icon, i18n::browser::BrowserStrings, manage, source::agent::Jobs, widgets::anchor,
};
use butler_ds::ui::{
    button::{Button, Size, Variant},
    context::Ds,
    dropdown_menu::{DropdownMenu, DropdownMenuContent, Item},
    icon::{IconSize, icon},
    overlay::place::Align,
    toast::{self, Toast},
    tooltip::Tooltip,
};
use gpui::{AnyElement, App, Window, div, prelude::*};

fn button(id: &'static str, text: impl Into<gpui::SharedString>, glyph: Icon, cx: &App) -> Button {
    Button::new(id)
        .variant(Variant::Ghost)
        .size(Size::Xs)
        .text(text)
        .icon_start(icon(glyph, IconSize::Sm, Ds::get(cx)))
}
fn open(session: &str, tab: &TabId, cx: &mut App) {
    cx.global_mut::<BrowserState>().activate(tab);
    cx.global_mut::<BrowserShell>()
        .remember_tab(session, tab.clone());
    open_conversation(session, cx);
    if let Some(ctx) = manage::window_ctx(cx) {
        ctx.open_session(session.to_owned().into(), cx);
    }
}
fn move_tab(tab: &TabId, session: &str, show: bool, cx: &mut App) {
    let value = cx.update_global::<BrowserState, _>(|model, cx| {
        model.move_tab(tab, Owner::Conversation(session.to_owned().into()), 0, cx)
    });
    if value.is_ok() {
        if show {
            open(session, tab, cx);
        } else {
            cx.global_mut::<BrowserState>().activate(tab);
            cx.global_mut::<BrowserShell>()
                .remember_tab(session, tab.clone());
        }
    }
    result(&value, cx);
}
fn create(tab: TabId, cx: &mut App) {
    let title = BrowserStrings::get(cx).new_conversation;
    let request = Jobs::run(cx, move |client| async move {
        client.create_session(Some(title)).await
    });
    cx.spawn(async move |cx| {
        let reply = request.await;
        cx.update(|cx| {
            if let Some(Ok(raw)) = reply
                && let Some(session) = raw["session"]["id"].as_str()
            {
                if let Some(ctx) = manage::window_ctx(cx) {
                    ctx.refresh_navigation(cx);
                }
                move_tab(&tab, session, true, cx);
            } else {
                toast::show(cx, Toast::error(BrowserStrings::get(cx).failed));
            }
        });
    })
    .detach();
}

pub(crate) fn hub(window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    let c = BrowserStrings::get(cx);
    let model = cx.global::<BrowserState>();
    let tab = model.active().and_then(|id| model.tab(id)).cloned();
    if let Some(tab) = &tab
        && let Owner::Conversation(session) = &tab.owner
    {
        let label = title(session, cx)?;
        let session = session.clone();
        let id = tab.id.clone();
        return Some(
            button("browser-hub-conversation", label, Icon::MessageSquare, cx)
                .on_click(move |_, _, cx| open(&session, &id, cx))
                .into_any_element(),
        );
    }
    if tab.is_none() {
        return Some(
            Tooltip::new("browser-move-unavailable")
                .label(c.new_tab)
                .child(
                    button(
                        "browser-move-trigger",
                        c.move_to_conversation,
                        Icon::MessageSquarePlus,
                        cx,
                    )
                    .disabled(),
                )
                .into_any_element(),
        );
    }
    let menu = DropdownMenu::new("browser-hub-move", window, cx);
    let trigger = menu.trigger(|toggle| {
        let trigger = button(
            "browser-move-trigger",
            c.move_to_conversation,
            Icon::MessageSquarePlus,
            cx,
        )
        .on_click(toggle.on_click());
        anchor(div(), "browser-move-trigger")
            .flex()
            .items_center()
            .child(trigger)
            .into_any_element()
    });
    let mut content = DropdownMenuContent::new();
    if let Some(tab) = tab {
        content = sessions(&tab.id, content, cx);
        content = content.child(
            Item::new(c.new_conversation)
                .icon(Icon::MessageSquarePlus)
                .on_select(move |_, cx| create(tab.id.clone(), cx)),
        );
    }
    Some(
        div()
            .flex()
            .items_center()
            .child(trigger)
            .child(menu.content(content, window, cx))
            .into_any_element(),
    )
}

fn sessions(tab: &TabId, mut content: DropdownMenuContent, cx: &App) -> DropdownMenuContent {
    if let Some(nav) = manage::window_ctx(cx).and_then(|ctx| ctx.navigation(cx)) {
        let mut sessions: Vec<_> = nav
            .chats
            .iter()
            .chain(
                nav.projects
                    .iter()
                    .flat_map(|p| p.sessions.iter().flatten()),
            )
            .filter(|s| !s.archived)
            .collect();
        sessions.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at));
        for session in sessions {
            let id = session.id.clone();
            let tab = tab.clone();
            content = content.child(
                Item::new(session.title.clone())
                    .icon(Icon::MessageSquare)
                    .on_select(move |_, cx| move_tab(&tab, &id, true, cx)),
            );
        }
    }
    content
}

pub(super) fn bring(session: &str, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = BrowserStrings::get(cx);
    let tabs: Vec<_> = cx
        .global::<BrowserState>()
        .tabs()
        .iter()
        .filter(|t| t.owner == Owner::Mine)
        .cloned()
        .collect();
    if tabs.is_empty() {
        return Tooltip::new("browser-bring-unavailable")
            .label(c.my_tabs)
            .child(button("browser-bring-trigger", c.bring_tab, Icon::TabIn, cx).disabled())
            .into_any_element();
    }
    let menu = DropdownMenu::new(format!("browser-bring:{session}"), window, cx);
    let trigger = menu.trigger(|toggle| {
        let trigger = button("browser-bring-trigger", c.bring_tab, Icon::TabIn, cx)
            .on_click(toggle.on_click());
        anchor(div(), "browser-bring-trigger")
            .flex()
            .items_center()
            .child(trigger)
            .into_any_element()
    });
    let mut content = DropdownMenuContent::new().align(Align::End);
    for tab in tabs {
        let session = session.to_owned();
        let label = if tab.title.is_empty() {
            c.new_tab.to_owned()
        } else {
            tab.title
        };
        content = content
            .child(Item::new(label).on_select(move |_, cx| move_tab(&tab.id, &session, false, cx)));
    }
    div()
        .flex()
        .items_center()
        .child(trigger)
        .child(menu.content(content, window, cx))
        .into_any_element()
}
