use super::{
    actions::{self, Action},
    copy::words,
    geometry::n,
};
use crate::ui::{browser::model::Tab, widgets::anchor};
use butler_ds::ui::{
    Icon,
    blocks::{
        page_band::{PageBand, PageBandTone},
        pick_outline::{PickOutline, PickOutlinePick, PickRect},
        selection_bar::{SelectionBar, SelectionBarAction},
    },
    button::{Button, Size, Variant},
};
use gpui::{
    AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window, canvas, div,
};

pub(crate) fn band(tab: &Tab, cx: &App) -> Option<PageBand> {
    if !tab.picking {
        return None;
    }
    let c = words(cx);
    let id = tab.id.clone();
    let (notice, action) = popup(tab, cx);
    let hint = if notice.is_some() { c.drag } else { c.keys };
    Some(
        PageBand::new("browser-pick-band", PageBandTone::Pick, c.mode)
            .detail(notice.unwrap_or_else(|| c.drag.to_owned()))
            .hint(hint)
            .icon(
                anchor(div(), "browser-pick-band").child(butler_ds::ui::icon::icon(
                    Icon::Pick,
                    butler_ds::ui::icon::IconSize::Sm,
                    butler_ds::ui::context::Ds::get(cx),
                )),
            )
            .actions(
                butler_ds::ui::button::container(Size::Xs)
                    .children(action)
                    .child(
                        Button::new("browser-pick-finish")
                            .size(Size::Xs)
                            .variant(Variant::Outline)
                            .text(c.finish)
                            .on_click(move |_, _, cx| super::mode(&id, false, cx)),
                    ),
            ),
    )
}
#[expect(
    clippy::cast_possible_truncation,
    reason = "viewport CSS coordinates fit f32"
)]
fn rect(value: &serde_json::Value) -> PickRect {
    PickRect::new(
        n(value, "x") as f32,
        n(value, "y") as f32,
        n(value, "width") as f32,
        n(value, "height") as f32,
    )
}
pub(crate) fn overlay(tab: &Tab, window: &mut Window, cx: &mut App) -> AnyElement {
    let tab = tab.clone();
    // PageCard provides the overlay in its scaled page coordinate space.
    let bounds = window.use_keyed_state(
        (gpui::ElementId::Name(tab.id.0.clone()), "pick-bounds"),
        cx,
        |_, _| gpui::Size::<gpui::Pixels>::default(),
    );
    let size = *bounds.read(cx);
    let recorder = canvas(
        move |area, _, cx| {
            bounds.update(cx, |size, _| *size = area.size);
        },
        |_, (), _, _| {},
    )
    .absolute()
    .size_full();
    let mut outline = PickOutline::new(
        "browser-pick-outline",
        f32::from(size.width),
        f32::from(size.height),
    )
    // Reader rects are page pixels (content pixels times the window zoom); gpui lays out content pixels.
    .scale(1.0 / window.zoom())
    .picks(tab.selections.iter().map(|p| {
        PickOutlinePick::new(
            p.data["id"].as_str().unwrap_or_default().to_owned(),
            rect(&p.data["rect"]),
        )
        .hidden(p.hidden)
    }));
    if let Some(hover) = &tab.pick_hover {
        outline = outline
            .hover(rect(&hover.rect))
            .hover_label(hover.label.clone());
    }
    let bar = bar(&tab, cx);
    anchor(div(), "browser-pick-overlay")
        .absolute()
        .size_full()
        .child(recorder)
        .child(
            anchor(div(), "browser-pick-outline")
                .absolute()
                .size_full()
                .child(outline),
        )
        .child(
            anchor(
                div(),
                &format!("browser-selection-count-{}", tab.selections.len()),
            )
            .absolute()
            .size_full()
            .child(bar),
        )
        .into_any_element()
}

fn bar(tab: &Tab, cx: &App) -> SelectionBar {
    let c = words(cx);
    let id = tab.id.clone();
    let mut bar = SelectionBar::new(
        "browser-selection-bar",
        tab.selections.len(),
        (c.selected)(tab.selections.len()),
        c.clear,
    )
    .hint(c.hint)
    .empty_reason(c.first)
    .on_clear(move |_, cx| super::clear(&id, cx));
    for (key, label, icon, action) in [
        ("attach", c.attach, Icon::MessageSquarePlus, Action::Attach),
        ("save-image", c.save, Icon::ImageIcon, Action::Save),
        ("copy-text", c.copy, Icon::Copy, Action::Copy),
        ("scrap", c.scrap, Icon::Scrap, Action::Scrap),
    ] {
        let id = tab.id.clone();
        bar = bar.action(
            SelectionBarAction::new(key, label, icon)
                .on_select(move |window, cx| actions::command(action, &id, window, cx)),
        );
    }
    if !tab.picking {
        bar = bar.compact();
    }
    bar
}

fn popup(tab: &Tab, cx: &App) -> (Option<String>, Option<AnyElement>) {
    let c = crate::ui::i18n::browser::BrowserStrings::get(cx);
    if let Some(blocked) = &tab.blocked_popup {
        let id = tab.id.clone();
        let action = (blocked.reason == "no_gesture").then(|| {
            anchor(div(), "browser-popup-allow")
                .child(
                    Button::new("browser-pick-popup-allow")
                        .size(Size::Xs)
                        .variant(Variant::Ghost)
                        .text(c.allow)
                        .on_click(move |_, _, cx| {
                            cx.global_mut::<crate::ui::browser::model::BrowserState>()
                                .allow_popup(&id);
                            cx.refresh_windows();
                        }),
                )
                .into_any_element()
        });
        return (Some(c.popup_blocked.to_owned()), action);
    }
    let model = cx.global::<crate::ui::browser::model::BrowserState>();
    let Some(child) = model
        .tabs()
        .iter()
        .find(|t| t.opener.as_ref() == Some(&tab.id))
    else {
        return (None, None);
    };
    let host = url::Url::parse(&child.url)
        .ok()
        .map(|u| u[url::Position::BeforeHost..url::Position::AfterPort].to_owned())
        .unwrap_or_default();
    let id = child.id.clone();
    let button = anchor(div(), "browser-popup-show")
        .child(
            Button::new("browser-pick-popup-show")
                .size(Size::Xs)
                .variant(Variant::Ghost)
                .text(c.show_popup)
                .on_click(move |_, _, cx| super::super::popup_window::focus(&id, cx)),
        )
        .into_any_element();
    (Some(format!("{} · {host}", c.popup_opened)), Some(button))
}
