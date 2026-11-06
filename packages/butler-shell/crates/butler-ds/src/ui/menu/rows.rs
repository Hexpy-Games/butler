//! The rows of a menu surface (DropdownMenu.module.css `.item`, `.label`, `.separator`,
//! `.shortcut`, `.indicator`): what a level draws, and the pointer handlers that feed the
//! runtime. Highlight is either the runtime's (keyboard focus, or the pointer's focus) or the
//! CSS `:hover` fill.
use gpui::{
    AnyElement, Div, ElementId, FontWeight, InteractiveElement as _, IntoElement as _, MouseButton,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, div, px,
};

use super::level::{Indicator, Kind, Selectable};
use super::runtime::{self, Row};
use super::{Env, Variant};
use crate::tokens::{Color, Length, Number};
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::icon::{IconSize, icon};
use crate::ui::overlay::popper::Anchor;

/// `padding: 0 9px` (DS: DropdownMenu.module.css:29).
const PAD_X: f32 = 9.;
/// The indicator's `right: 8px` (DS: DropdownMenu.module.css:51).
const INDICATOR_RIGHT: f32 = 8.;
/// A separator reaches over the surface's 6px padding by `-4px` (DS: DropdownMenu.module.css:70).
const SEPARATOR_BLEED: f32 = -4.;

/// A row's place in the menu: its level, the path of the submenu that holds it and its index.
pub(super) struct At<'a> {
    pub lvl: usize,
    pub path: &'a [usize],
    pub shown: bool,
    /// The submenu opened from this row, drawn as its child.
    pub sub: Option<AnyElement>,
    /// Measures the row for the submenu's placement.
    pub probe: Option<&'a Anchor>,
}

fn color(ds: &Ds, row: &Selectable) -> gpui::Hsla {
    if row.disabled {
        ds.color(Color::InteractiveDisabledFg)
    } else if row.variant == Variant::Destructive {
        ds.color(Color::Danger)
    } else {
        ds.color(Color::TextPrimary)
    }
}

/// `.indicator`: the check or minus at the end of the row, centred on it.
pub(crate) fn indicator_slot(ds: &Ds, glyph: Icon) -> Div {
    div()
        .absolute()
        .top_0()
        .bottom_0()
        .right(px(INDICATOR_RIGHT))
        .flex()
        .items_center()
        .justify_center()
        .child(icon(glyph, IconSize::Md, ds))
}

fn indicator(ds: &Ds, mark: Indicator) -> Option<Div> {
    mark.shown.then(|| {
        indicator_slot(
            ds,
            if mark.mixed {
                Icon::Minus
            } else {
                Icon::CheckIcon
            },
        )
    })
}

/// The box every menu or list item shares (`.item`): a flex row with the DS item height,
/// `0 9px` padding (`pad_right` where an indicator needs room) and the control radius.
pub(crate) fn frame(ds: &Ds, pad_right: f32, min_height: gpui::Pixels) -> Div {
    div()
        .relative()
        .flex()
        .items_center()
        .gap(ds.len(Length::SpaceSm))
        .min_h(min_height)
        .pl(px(PAD_X))
        .pr(px(pad_right))
        .py(ds.len(Length::MenuItemPaddingBlock))
        .line_height(ds.len(Length::MenuItemLineHeight))
        .rounded(ds.len(Length::RadiusControl))
}

/// The row itself: icon, label, shortcut or submenu chevron, indicator.
fn body(ds: &Ds, row: &Selectable, stateful: Div) -> Div {
    let tertiary = ds.color(Color::TextTertiary);
    let mut el = stateful
        .text_color(color(ds, row))
        .children(row.icon.map(|glyph| icon(glyph, IconSize::Sm, ds)))
        .child(div().whitespace_nowrap().child(row.label.clone()));
    el = el.children(row.shortcut.as_ref().map(|text| {
        div()
            .ml_auto()
            .text_color(tertiary)
            .text_size(ds.len(Length::FontSize1))
            .child(text.clone())
    }));
    match &row.kind {
        Kind::Sub(_) => el.child(div().ml_auto().text_color(tertiary).child(icon(
            Icon::ChevronRight,
            IconSize::Md,
            ds,
        ))),
        Kind::Item {
            indicator: Some(mark),
            ..
        } => el.children(indicator(ds, *mark)),
        Kind::Item { .. } => el,
    }
}

/// A selectable row with its pointer handlers.
pub(super) fn item(env: &Env, ds: &Ds, row: &Selectable, at: At<'_>) -> AnyElement {
    let name = format!("{}-item-{}-{}", env.id, at.lvl, row.idx);
    let id: ElementId = SharedString::from(name.clone()).into();
    let place = Row {
        lvl: at.lvl,
        idx: row.idx,
        disabled: row.disabled,
        sub: matches!(row.kind, Kind::Sub(_)),
    };
    let mut full: Vec<usize> = at.path.to_vec();
    full.push(row.idx);
    let (rt, leave_rt) = (env.rt.clone(), env.rt.clone());
    let selection = ds.color(Color::Selection);
    let mut el = body(ds, row, frame(ds, PAD_X, ds.len(Length::MenuItemHeight)))
        .id(id)
        .debug_selector(move || name.clone())
        .on_mouse_move(move |event, window, cx| {
            runtime::pointer_move(&rt, place, event.position, window, cx);
        });
    el = el.on_hover(move |hovered, window, cx| {
        if !*hovered {
            runtime::pointer_leave(&leave_rt, place, &full, window, cx);
        }
    });
    if row.disabled {
        el = el.cursor_not_allowed();
    } else {
        el = el
            .cursor_pointer()
            .hover_style(move |style| style.bg(selection));
        if at.shown {
            el = el.bg(selection);
        }
        el = el.on_mouse_up(MouseButton::Left, activation(env, row, &at));
    }
    el.children(at.probe.map(Anchor::probe))
        .children(at.sub)
        .into_any_element()
}

type Activation = Box<dyn Fn(&gpui::MouseUpEvent, &mut gpui::Window, &mut gpui::App)>;

/// A left button release on the row (a press, drag and release lands here too): an item runs
/// its action and may close the menu, a submenu trigger opens its submenu.
fn activation(env: &Env, row: &Selectable, at: &At<'_>) -> Activation {
    let (menu, rt) = (env.menu.clone(), env.rt.clone());
    let (lvl, idx) = (at.lvl, row.idx);
    match &row.kind {
        Kind::Sub(_) => Box::new(move |_, _, cx| {
            rt.update(cx, |rt, cx| {
                if rt.path.get(lvl) != Some(&idx) {
                    rt.open_sub(lvl, idx, None, false);
                }
                rt.set_highlight(lvl, Some(idx));
                cx.notify();
            });
        }),
        Kind::Item { action, .. } => {
            let action = action.clone();
            Box::new(move |_, window, cx| {
                if action(window, cx) {
                    menu.close(window, cx);
                }
            })
        }
    }
}

/// `DropdownMenuLabel`.
pub(super) fn label(ds: &Ds, text: &SharedString) -> AnyElement {
    div()
        .pt(ds.len(Length::SpaceSm))
        .px(ds.len(Length::Space2))
        .pb(ds.len(Length::SpaceXs))
        .text_color(ds.color(Color::MenuGroupLabelColor))
        .text_size(ds.len(Length::MenuGroupLabelSize))
        .line_height(ds.len(Length::MenuGroupLabelLineHeight))
        .font_weight(FontWeight(ds.number(Number::MenuGroupLabelWeight)))
        .child(text.clone())
        .into_any_element()
}

/// `DropdownMenuSeparator`.
pub(crate) fn separator(ds: &Ds) -> AnyElement {
    div()
        .h(ds.len(Length::BorderHairline))
        .mx(px(SEPARATOR_BLEED))
        .my(ds.len(Length::SpaceXs))
        .bg(ds.color(Color::Line))
        .into_any_element()
}
