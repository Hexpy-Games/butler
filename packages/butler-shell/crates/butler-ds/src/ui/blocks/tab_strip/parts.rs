//! The strip's small parts: the favicon slot, the ghost icon buttons, the group title ("chip")
//! with its folded preview, and a group's own new-tab button.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, FocusHandle, FontWeight, ImageSource,
    InteractiveElement as _, IntoElement as _, ObjectFit, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledImage as _, Window, div, img, px,
};

use super::model::{Favicon, Group, GroupState, Tab, TabState, chip_key};
use super::{Scope, hover_listener};
use crate::tokens::{Color, Length, Number};
use crate::ui::button::{Button, Size as ButtonSize, Variant as ButtonVariant};
use crate::ui::context::Ds;
use crate::ui::control::{Blend, Control, Disabled, DisabledLook, Width};
use crate::ui::icon::{IconSize, icon, icon_px};
use crate::ui::spinner::Spinner;
use crate::ui::thinking_mark::{ButlerThinkingMark, MarkState};
use crate::ui::tooltip::Tooltip;
use crate::ui::typo::{Tone, Typo};
use crate::ui::{Icon, convert};

/// A folded group previews this many favicons, then counts the rest.
const FOLDED_FAVICONS: usize = 3; // DS: TabStripGroup.tsx:29
/// The site tile of `Favicon::Letter`: corner radius and letter size in its 16px square.
const TILE_RADIUS: f32 = 4.; // DS: TabStrip.demo.tsx:15
const TILE_LETTER: f32 = 9.; // DS: TabStrip.demo.tsx:15
/// The image favicon's corner (`calc(2px / var(--ui-scale))`, radii are scale-compensated).
const IMAGE_RADIUS: f32 = 2.; // DS: TabStrip.module.css:233

fn image(src: ImageSource, side: gpui::Pixels) -> AnyElement {
    img(src)
        .size_full()
        .rounded(px(IMAGE_RADIUS))
        .object_fit(ObjectFit::Contain)
        .with_fallback(move || icon_px(Icon::Globe2, side).into_any_element())
        .into_any_element()
}

/// An opaque colour from `0xRRGGBB`.
fn hex(rgb: u32) -> gpui::Hsla {
    let channel = |shift: u32| ((rgb >> shift) & 0xff) as f32 / 255.;
    convert::hsla(crate::tokens::Rgba {
        r: channel(16),
        g: channel(8),
        b: channel(0),
        a: 1.,
    })
}

fn tile(rgb: u32, letter: char, ds: &Ds) -> AnyElement {
    div()
        .flex()
        .items_center()
        .justify_center()
        .size_full()
        .rounded(px(TILE_RADIUS))
        .bg(hex(rgb))
        .text_color(ds.color(Color::NeutralWhite))
        .text_size(px(TILE_LETTER))
        .font_weight(FontWeight::BOLD)
        .child(letter.to_string())
        .into_any_element()
}

/// The favicon slot: activity replaces the site icon; a missing or broken icon shows a globe.
pub(super) fn favicon(tab: &Tab, id: &ElementId, ds: &Ds) -> AnyElement {
    let side = ds.len(Length::IconSizeMd);
    let mark = match (tab.state, &tab.icon, &tab.favicon) {
        (Some(TabState::Loading), ..) => Spinner::new((id.clone(), "spinner"))
            .size(14.) // DS: TabStripTab.tsx:18
            .into_any_element(),
        (Some(TabState::Working), ..) => ButlerThinkingMark::new((id.clone(), "mark"))
            .state(MarkState::Working)
            .size(IconSize::Sm)
            .into_any_element(),
        (Some(TabState::Crashed), ..) => {
            icon(Icon::AlertCircle, IconSize::Md, ds).into_any_element()
        }
        (None, Some(glyph), _) => icon(*glyph, IconSize::Md, ds).into_any_element(),
        (None, None, Some(Favicon::Image(src))) => image(src.clone(), side),
        (None, None, Some(Favicon::Letter { rgb, letter })) => tile(*rgb, *letter, ds),
        (None, None, _) => icon(Icon::Globe2, IconSize::Md, ds).into_any_element(),
    };
    let mut cell = div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(side);
    if tab.state == Some(TabState::Crashed) {
        cell = cell.text_color(ds.color(Color::ColorDangerText));
    }
    cell.child(mark).into_any_element()
}

type Click = Rc<dyn Fn(&mut Window, &mut App)>;

/// A ghost icon button named by a tooltip (IconButton, with the roving tab stop and the focus
/// handle the strip owns).
pub(super) struct Ghost {
    pub(super) id: ElementId,
    pub(super) label: SharedString,
    pub(super) glyph: Icon,
    pub(super) size: IconSize,
    pub(super) handle: Option<FocusHandle>,
    pub(super) tab_stop: bool,
    pub(super) on_click: Option<Click>,
}

pub(super) fn ghost(button: Ghost, ds: &Ds) -> AnyElement {
    let Ghost {
        id,
        label,
        glyph,
        size,
        handle,
        tab_stop,
        on_click,
    } = button;
    let mut control = Button::new(id.clone())
        .variant(ButtonVariant::Ghost)
        .size(ButtonSize::IconSm)
        .control(ds);
    let side = ghost_side(ds);
    control.width = Width::Fixed(side);
    control.height = Some(px(side));
    control.min_height = Some(px(side));
    control.radius = ds.len(Length::RadiusPill);
    control.disabled_look = DisabledLook::Opacity(0.42); // DS: IconButton.module.css:40
    control.fill = Blend::hover(gpui::transparent_black(), ds.color(Color::Selection));
    control.fg = Blend::hover(ds.color(Color::TextSecondary), ds.color(Color::TextPrimary));
    control.padding = [px(0.); 4];
    control.focus = handle;
    control.tab_stop = tab_stop;
    control.on_click(
        on_click.map(|click| -> Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)> {
            Rc::new(move |_, window, cx| click(window, cx))
        }),
    );
    control.children = vec![icon(glyph, size, ds).into_any_element()];
    Tooltip::new((id, "tooltip"))
        .label(label)
        .child(control)
        .into_any_element()
}

/// A group's own new-tab button at the end of its pill: a stop after its tabs.
pub(super) fn group_new(group: &Group, scope: &Scope, ds: &Ds) -> AnyElement {
    let key = super::model::new_key(&group.id);
    let target = group.id.clone();
    let on_new = scope.on_new_in.clone();
    let click: Option<Click> =
        on_new.map(|new| -> Click { Rc::new(move |window, cx| new(&target, window, cx)) });
    div()
        .flex()
        .flex_none()
        .child(ghost(
            Ghost {
                id: scope.control_id(&key),
                label: (scope.labels.new_tab_in)(&scope.labels.group_label(group)).into(),
                glyph: Icon::Plus,
                size: IconSize::Sm,
                handle: scope.handles.get(&key).cloned(),
                tab_stop: scope.roving.as_ref() == Some(&key),
                on_click: click,
            },
            ds,
        ))
        .into_any_element()
}

fn state_mark(state: GroupState, id: &ElementId, ds: &Ds) -> AnyElement {
    let mark = match state {
        GroupState::Working => ButlerThinkingMark::new((id.clone(), "mark"))
            .state(MarkState::Working)
            .size(IconSize::Sm)
            .into_any_element(),
        GroupState::Waiting => icon(Icon::ShieldQuestion, IconSize::Sm, ds).into_any_element(),
        GroupState::Crashed => icon(Icon::AlertCircle, IconSize::Sm, ds).into_any_element(),
    };
    let tone = match state {
        GroupState::Waiting => Some(Color::ColorWarningText),
        GroupState::Crashed => Some(Color::ColorDangerText),
        GroupState::Working => None,
    };
    let cell = div().flex().flex_none().items_center().justify_center();
    match tone {
        Some(color) => cell.text_color(ds.color(color)),
        None => cell,
    }
    .child(mark)
    .into_any_element()
}

/// A folded group's first favicons and the count of the rest.
fn folded_preview(group: &Group, scope: &Scope, id: &ElementId, ds: &Ds) -> AnyElement {
    let shown = group.tabs.iter().take(FOLDED_FAVICONS);
    let rest = group.tabs.len().saturating_sub(FOLDED_FAVICONS);
    div()
        .flex()
        .flex_none()
        .items_center()
        .gap(ds.len(Length::SpaceXs))
        .children(shown.map(|tab| favicon(tab, &ElementId::from((id.clone(), tab.id.clone())), ds)))
        .children((rest > 0).then(|| {
            Typo::caption((scope.labels.more_tabs)(rest))
                .tone(Tone::Tertiary)
                .tabular()
                .into_any_element()
        }))
        .into_any_element()
}

/// The group's title: folds and unfolds the group, shows the group state. Without a toggle
/// handler it is disabled (the text-tone family).
pub(super) fn chip(group: &Group, scope: &Scope, ds: &Ds) -> AnyElement {
    let key = chip_key(&group.id);
    let id = scope.control_id(&key);
    let label = scope.labels.group_label(group);
    let active_within = group.collapsed
        && group
            .tabs
            .iter()
            .any(|tab| scope.active.as_ref() == Some(&tab.id));
    let strong = ds.color(Color::SelectionStrong);
    let mut control = Control::new(id.clone(), ds);
    control.radius = ds.len(Length::RadiusPill);
    control.min_height = Some(ds.len(Length::ControlHeightMd));
    control.padding = [
        ds.len(Length::SpaceMd),
        px(0.),
        ds.len(Length::SpaceSm),
        px(0.),
    ];
    control.gap = ds.len(Length::SpaceSm);
    control.text_size = ds.len(Length::FontSize2);
    control.line_height = Some(ds.len(Length::TypoLabelLineHeightTight));
    control.scale = false;
    control.justify_center = false;
    control.inline = true;
    control.fg = Blend::flat(ds.color(if group.is_mine() || active_within {
        Color::TextPrimary
    } else {
        Color::TextSecondary
    }));
    control.fill = if active_within {
        Blend::flat(strong)
    } else {
        Blend {
            rest: gpui::transparent_black(),
            hover: ds.color(Color::Selection),
            active: Some(strong),
        }
    };
    control.focus = scope.handles.get(&key).cloned();
    control.tab_stop = scope.roving.as_ref() == Some(&key);
    if scope.on_toggle.is_none() {
        control.disabled = Disabled::Native;
        control.disabled_look = DisabledLook::Text;
    }
    let toggle = scope.on_toggle.clone();
    let (target, collapsed) = (group.id.clone(), group.collapsed);
    control.on_click(
        toggle.map(|toggle| -> Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)> {
            Rc::new(move |_, window, cx| toggle(&target, !collapsed, window, cx))
        }),
    );
    let size = ds.len(Length::FontSize2);
    let mut children = Vec::new();
    if let Some(state) = group.state {
        children.push(state_mark(state, &id, ds));
    }
    children.push(
        div()
            .min_w(size * 2.)
            .max_w(ds.len(Length::TabStripChipMaxWidth))
            .flex_shrink(1.)
            .overflow_hidden()
            .whitespace_nowrap()
            .text_ellipsis()
            .font_weight(FontWeight(ds.number(Number::FontWeightMedium)))
            .child(label.clone())
            .into_any_element(),
    );
    if group.collapsed && !group.tabs.is_empty() {
        children.push(folded_preview(group, scope, &id, ds));
    }
    control.children = children;
    // The capped label truncates; the tooltip keeps the full name and the group state.
    let tip = match group.state {
        Some(state) => format!("{label} · {}", scope.labels.group_state(state)),
        None => label.to_string(),
    };
    div()
        .id((id.clone(), "slot"))
        .flex()
        .flex_none()
        .on_hover(hover_listener(scope.hover.clone(), key))
        .child(Tooltip::new((id, "tip")).label(tip).child(control))
        .into_any_element()
}

/// The side of a ghost icon button (`--control-height-md`, at least the hit target when compact).
pub(super) fn ghost_side(ds: &Ds) -> f32 {
    let side = f32::from(ds.len(Length::ControlHeightMd));
    if ds.compact() {
        side.max(f32::from(ds.len(Length::ControlHitTarget)))
    } else {
        side
    }
}
