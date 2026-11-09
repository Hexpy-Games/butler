//! One tab (TabStripTab.tsx): a pill with the favicon, the title and a close button that shows on
//! hover or keyboard focus; the divider before it; and the reveal of the active tab in the
//! scroller.
use std::rc::Rc;

use gpui::{
    AnyElement, App, Entity, InteractiveElement as _, IntoElement as _, MouseButton,
    ParentElement as _, Pixels, ScrollHandle, SharedString, StatefulInteractiveElement as _,
    Styled as _, canvas, div, px,
};

use super::model::{Tab, tab_key};
use super::parts::{Click, Ghost, favicon, ghost, ghost_side};
use super::{Scope, hover_listener};
use crate::tokens::{Color, Length, Number};
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::control::{Blend, Control, Handler, Width};
use crate::ui::convert;
use crate::ui::icon::IconSize;

/// Container-query thresholds of the slot (`@container (max-width: ...)`).
const DROP_CLOSE_AT: f32 = 127.; // DS: TabStrip.module.css:262
const DROP_TITLE_AT: f32 = 71.; // DS: TabStrip.module.css:268
/// The divider's inset from the slot (half the tab gap and half its own width).
const GAP: f32 = super::GAP;

/// The scroller and what remembers the tab it last scrolled into view.
#[derive(Clone)]
pub(super) struct Reveal {
    pub(super) handle: ScrollHandle,
    pub(super) done: Entity<Option<SharedString>>,
    pub(super) fade: Pixels,
}

/// Scrolls the tab into the scroller's visible span, clear of the edge fade (revealInScroller),
/// once per change of the active tab.
fn reveal(bounds: gpui::Bounds<Pixels>, want: &Reveal, tab: &SharedString, cx: &mut App) -> bool {
    if want.done.read(cx).as_ref() == Some(tab) {
        return false;
    }
    let view = want.handle.bounds();
    if view.size.width <= px(0.) {
        return false;
    }
    want.done.update(cx, |done, _| *done = Some(tab.clone()));
    let max = want.handle.max_offset().x;
    if max <= px(0.) {
        return false;
    }
    let clearance = (view.size.width / 4.).min(want.fade);
    let delta = if bounds.left() < view.left() + clearance {
        bounds.left() - view.left() - clearance
    } else if bounds.right() > view.right() - clearance {
        bounds.right() - view.right() + clearance
    } else {
        return false;
    };
    let mut offset = want.handle.offset();
    offset.x = (offset.x - delta).max(-max).min(px(0.));
    want.handle.set_offset(offset);
    true
}

fn reveal_probe(want: &Reveal, tab: SharedString) -> AnyElement {
    let want = want.clone();
    canvas(
        |_, _, _| (),
        move |bounds, (), window, cx| {
            if reveal(bounds, &want, &tab, cx) {
                crate::ui::motion::remeasure(window);
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
    .into_any_element()
}

/// What places a tab in its group.
pub(super) struct Place<'a> {
    pub(super) tab: &'a Tab,
    /// The stop before it (its group's title or the tab before it): the divider sits between.
    pub(super) prev: Option<SharedString>,
    /// Conversation tabs are quieter than the user's own until selected.
    pub(super) muted: bool,
    /// Inside a pill every open tab takes the one measured width.
    pub(super) pill: bool,
}

fn divider(ds: &Ds) -> AnyElement {
    let hairline = ds.len(Length::BorderHairline);
    let left = -(px(GAP) / 2. + hairline / 2.);
    div()
        .absolute()
        .top_0()
        .bottom_0()
        .left(left)
        .w(hairline)
        .flex()
        .items_center()
        .child(
            div()
                .w_full()
                .h(ds.len(Length::IconSizeMd))
                .bg(ds.color(Color::Line)),
        )
        .into_any_element()
}

fn close_button(place: &Place, scope: &Scope, visible: bool, ds: &Ds) -> AnyElement {
    let id = scope.control_id(&tab_key(&place.tab.id));
    let target = place.tab.id.clone();
    let close = scope.on_close.clone();
    let wrap = div()
        .id((id.clone(), "close-wrap"))
        .absolute()
        .top_0()
        .bottom_0()
        .right(ds.len(Length::SpaceXs))
        .flex()
        .items_center()
        // The button's press must not reach the tab under it.
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(|_, _, cx| cx.stop_propagation());
    let wrap = if visible { wrap } else { wrap.invisible() };
    wrap.child(ghost(
        Ghost {
            id: (id, "close").into(),
            label: scope.labels.close_tab.clone(),
            glyph: Icon::X,
            size: IconSize::Sm,
            handle: None,
            tab_stop: false,
            on_click: close
                .map(|close| -> Click { Rc::new(move |window, cx| close(&target, window, cx)) }),
        },
        ds,
    ))
    .into_any_element()
}

/// The tab's control: fill, text and the favicon and title inside.
fn control(place: &Place, scope: &Scope, narrow: (bool, bool), ds: &Ds) -> Control {
    let Place { tab, .. } = place;
    let key = tab_key(&tab.id);
    let id = scope.control_id(&key);
    let active = scope.active.as_ref() == Some(&tab.id);
    let (xs, sm) = (ds.len(Length::SpaceXs), ds.len(Length::SpaceSm));
    let strong = ds.color(Color::SelectionStrong);
    let show_close = tab.closable && (active || !narrow.0);
    let mut control = Control::new(id.clone(), ds);
    control.radius = ds.len(Length::RadiusPill);
    control.width = Width::Full;
    control.inline = false;
    control.min_height = Some(ds.len(Length::ControlHeightMd));
    control.scale = false;
    control.text_size = ds.len(Length::FontSize2);
    control.line_height = Some(ds.len(Length::TypoLabelLineHeightTight));
    control.gap = sm;
    control.weight = ds.number(if active {
        Number::FontWeightMedium
    } else {
        Number::FontWeightRegular
    });
    control.justify_center = narrow.1;
    let end = if show_close {
        xs + px(ghost_side(ds))
    } else {
        xs
    };
    control.padding = if narrow.1 {
        [xs, px(0.), xs, px(0.)]
    } else {
        [sm, px(0.), end, px(0.)]
    };
    control.fg = Blend::flat(ds.color(if place.muted && !active {
        Color::TextSecondary
    } else {
        Color::TextPrimary
    }));
    control.fill = if active {
        Blend::flat(strong)
    } else {
        Blend {
            rest: gpui::transparent_black(),
            hover: convert::with_alpha(ds.color(Color::Selection), 0.6), // DS: TabStrip.module.css:134
            active: Some(strong),
        }
    };
    control.focus = scope.handles.get(&key).cloned();
    control.tab_stop = scope.roving.as_ref() == Some(&key);
    let (pick, target) = (scope.on_activate.clone(), tab.id.clone());
    control.on_click(
        pick.map(|pick| -> Handler { Rc::new(move |_, window, cx| pick(&target, window, cx)) }),
    );
    let mut children = vec![favicon(tab, &id, ds)];
    if !narrow.1 {
        children.push(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(scope.labels.tab_title(tab))
                .into_any_element(),
        );
    }
    control.children = children;
    control
}

/// One tab slot: the tab, its close button, the divider before it and the measuring probes.
pub(super) fn slot(place: &Place, scope: &Scope, ds: &Ds) -> AnyElement {
    let tab = place.tab;
    let key = tab_key(&tab.id);
    let id = scope.control_id(&key);
    let active = scope.active.as_ref() == Some(&tab.id);
    let measure = key.clone();
    let width = scope.width(&measure);
    let narrow = (
        width > 0. && width <= DROP_CLOSE_AT,
        width > 0. && width <= DROP_TITLE_AT,
    );
    let show_close = tab.closable && (active || !narrow.0);
    let min = ds.len(Length::TabStripTabMinWidth);
    let mut slot = div()
        .id((id.clone(), "slot"))
        .relative()
        .flex()
        .on_hover(hover_listener(scope.hover.clone(), key.clone()));
    // `.slot[data-active]`: the selected tab stops shrinking earlier, fitted or not.
    let floor = if active {
        min + ds.len(Length::Space2xl)
    } else {
        min
    };
    slot = match scope.fit.filter(|_| place.pill) {
        Some(fit) => slot.flex_none().w(px(fit)).min_w(floor),
        None => slot
            .flex_shrink(1.)
            .w(ds.len(Length::TabStripTabMaxWidth))
            .min_w(floor),
    };
    if tab.closable {
        let (close, target) = (scope.on_close.clone(), tab.id.clone());
        slot = slot.on_mouse_up(MouseButton::Middle, move |_, window, cx| {
            if let Some(close) = &close {
                close(&target, window, cx);
            }
        });
    }
    let lit = scope.lit(&key);
    let divided = place
        .prev
        .as_ref()
        .is_some_and(|prev| !(lit || scope.lit(prev)));
    slot.child(control(place, scope, narrow, ds))
        .children(show_close.then(|| close_button(place, scope, scope.reveals_close(&key), ds)))
        .children(divided.then(|| divider(ds)))
        .children(scope.recorder(&measure))
        .children(active.then(|| reveal_probe(&scope.reveal, tab.id.clone())))
        .into_any_element()
}
