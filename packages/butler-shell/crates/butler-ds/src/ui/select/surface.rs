//! The Select list surface (Select.module.css `.content`, `.item`, `.label`, `.scrollButton`):
//! the glass with the scroll buttons and the viewport of rows, its key handler and focus, and
//! the window-level pointer listeners of press, drag and release.
use std::rc::Rc;

use gpui::{
    AnyElement, App, Div, FocusHandle, InteractiveElement as _, IntoElement as _, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement as _, SharedString, Stateful,
    StatefulInteractiveElement as _, Styled as _, canvas, div, px,
};

use super::Select;
use super::aligned::Geometry;
use super::entry::Row;
use super::runtime::{self, Way};
use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::icon::{IconSize, icon};
use crate::ui::menu::{indicator_slot, item_frame, separator};
use crate::ui::tinted_glass::{GlassPadding, GlassRadius, TintedGlass};

/// The surface's padding. // DS: Select.module.css:92
pub(super) const PADDING: f32 = 6.;
/// `min-width: 9rem` at the DS View's 16px rem. // DS: Select.module.css:91
const MIN_WIDTH: f32 = 144.;
/// `padding: 0 30px 0 9px`: room for the check. // DS: Select.module.css:119
const PAD_RIGHT: f32 = 30.;

/// What a frame of the list shows.
pub(super) struct View<'a> {
    pub rows: &'a Rc<Vec<Row>>,
    pub value: Option<SharedString>,
    /// Where the highlight starts: the selected item, else the first enabled.
    pub start: Option<usize>,
    pub selected: Option<usize>,
    pub geometry: Option<Geometry>,
    pub popper: bool,
}

pub(super) fn index_of(rows: &[Row], value: &SharedString) -> Option<usize> {
    rows.iter().find_map(|row| match row {
        Row::Item { idx, value: v, .. } if v == value => Some(*idx),
        _ => None,
    })
}

pub(super) fn first_enabled(rows: &[Row]) -> Option<usize> {
    rows.iter().find_map(|row| match row {
        Row::Item {
            idx,
            disabled: false,
            ..
        } => Some(*idx),
        _ => None,
    })
}

/// The place of item `idx` among all the rows.
pub(super) fn position_of(rows: &[Row], idx: usize) -> Option<usize> {
    rows.iter()
        .position(|row| matches!(row, Row::Item { idx: i, .. } if *i == idx))
}

/// The list: glass, scroll buttons and the scrolling viewport.
pub(super) fn build(sel: &Select, view: &View<'_>, focus: &FocusHandle, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let (highlight, (up, down), scroll) = {
        let rt = sel.rt.read(cx);
        (rt.highlight, rt.scroll_buttons(), rt.scroll.clone())
    };
    let step = sel
        .parts
        .item
        .bounds()
        .map_or(f32::from(ds.len(Length::MenuItemHeight)), |b| {
            f32::from(b.size.height)
        });
    let rows = row_elements(sel, view, ds, highlight);
    let limit = if view.popper {
        sel.parts
            .output
            .get()
            .map(|resolved| resolved.available_height)
    } else {
        view.geometry.map(|geometry| geometry.height)
    };
    let min_width = view
        .geometry
        .map_or(MIN_WIDTH, |g| g.min_width.max(MIN_WIDTH));
    let min_list = view
        .popper
        .then(|| sel.parts.trigger.bounds().map(|b| f32::from(b.size.width)))
        .flatten();
    let buttons = (
        up.then(|| scroll_button(sel, ds, Way::Up, step)),
        down.then(|| scroll_button(sel, ds, Way::Down, step)),
    );
    let viewport = viewport(sel, &scroll, rows, min_list);
    let border = f32::from(ds.len(Length::BorderHairline));
    let mut inner = div()
        .flex()
        .flex_col()
        .p(px(PADDING))
        .text_color(ds.color(Color::TextPrimary))
        .children(buttons.0)
        .child(viewport)
        .children(buttons.1);
    if let Some(limit) = limit {
        inner = inner.max_h(px(limit - 2. * border));
    }
    let glass = TintedGlass::new()
        .radius(GlassRadius::Popover)
        .padding(GlassPadding::None)
        .child(inner);
    let keys = (sel.clone(), view.rows.clone());
    let mut sized = div()
        .relative()
        .flex()
        .flex_col()
        .min_w(px(min_width))
        .track_focus(focus)
        .tab_stop(false)
        .on_key_down(move |event, window, cx| {
            if super::keys::handle(&keys.0, &keys.1, event, window, cx) {
                cx.stop_propagation();
            }
        })
        .child(glass)
        .child(sel.parts.content.probe())
        .child(pointer_guard(sel))
        .debug_selector(|| "select-content".to_owned());
    if let Some(limit) = limit {
        sized = sized.max_h(px(limit));
    }
    sized.into_any_element()
}

/// The rows of the list, with the highlight and the chosen value marked.
fn row_elements(
    sel: &Select,
    view: &View<'_>,
    ds: &Ds,
    highlight: Option<usize>,
) -> Vec<AnyElement> {
    let probe = view.selected.or(view.start);
    view.rows
        .iter()
        .map(|row| match row {
            Row::Item {
                idx,
                value,
                label,
                icon,
                disabled,
            } => {
                let state = ItemState {
                    selected: view.value.as_ref() == Some(value),
                    highlighted: highlight == Some(*idx),
                    probe: probe == Some(*idx),
                };
                item(sel, ds, (*idx, value, label, icon, *disabled), &state)
            }
            Row::Label(text) => label(ds, text),
            Row::Separator => separator(ds).into_any_element(),
        })
        .collect()
}

/// The viewport: it scrolls, its scrollbar hidden, and is measured for the positioning.
fn viewport(
    sel: &Select,
    scroll: &gpui::ScrollHandle,
    rows: Vec<AnyElement>,
    min_width: Option<f32>,
) -> AnyElement {
    let mut list = div()
        .id(SharedString::from(format!("{}-viewport", sel.id)))
        .flex()
        .flex_col()
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .track_scroll(scroll)
        .on_scroll_wheel(|_, window, _| window.refresh())
        .children(rows);
    if let Some(width) = min_width {
        list = list.min_w(px(width));
    }
    div()
        .relative()
        .flex()
        .flex_col()
        .flex_1()
        .min_h_0()
        .child(list)
        .child(sel.parts.viewport.probe())
        .into_any_element()
}

struct ItemState {
    selected: bool,
    highlighted: bool,
    probe: bool,
}

type ItemData<'a> = (
    usize,
    &'a SharedString,
    &'a SharedString,
    &'a Option<super::entry::Icon>,
    bool,
);

/// An option row: check (when chosen), glyph slot, label.
fn item(
    sel: &Select,
    ds: &Ds,
    (idx, value, text, glyph, disabled): ItemData<'_>,
    state: &ItemState,
) -> AnyElement {
    let min = if ds.compact() {
        ds.len(Length::ControlHitTarget)
    } else {
        ds.len(Length::MenuItemHeight)
    };
    let selection = ds.color(Color::Selection);
    let label = div()
        .relative()
        .whitespace_nowrap()
        .child(text.clone())
        .children(state.probe.then(|| sel.parts.text.probe()));
    let slot = glyph.as_ref().map(|make| {
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .w(ds.len(Length::IconSizeMd))
            .h(ds.len(Length::IconSizeMd))
            .child(make())
    });
    let name = format!("{}-item-0-{idx}", sel.id);
    let mut el = item_frame(ds, PAD_RIGHT, min)
        .id(SharedString::from(name.clone()))
        .debug_selector(move || name.clone())
        .flex_none()
        .text_color(if disabled {
            ds.color(Color::InteractiveDisabledFg)
        } else {
            ds.color(Color::TextPrimary)
        })
        .children(state.selected.then(|| indicator_slot(ds, Icon::CheckIcon)))
        .children(slot)
        .child(label)
        .children(state.probe.then(|| sel.parts.item.probe()));
    el = track_pointer(el, sel, idx, disabled);
    if disabled {
        return el.cursor_not_allowed().into_any_element();
    }
    el = el
        .cursor_pointer()
        .hover_style(move |style| style.bg(selection));
    if state.highlighted {
        el = el.bg(selection);
    }
    let (chooser, value) = (sel.clone(), value.clone());
    el.on_mouse_up(MouseButton::Left, move |event, window, cx| {
        if chooser
            .rt
            .update(cx, |rt, _| rt.takes_release(event.position))
        {
            chooser.choose(value.clone(), window, cx);
        }
    })
    .into_any_element()
}

/// The pointer takes the highlight over an item and drops it on leaving (Radix focuses the
/// item under the pointer); a disabled item takes none.
fn track_pointer(el: Stateful<Div>, sel: &Select, idx: usize, disabled: bool) -> Stateful<Div> {
    let (moved, left) = (sel.rt.clone(), sel.rt.clone());
    el.on_mouse_move(move |_, _, cx| {
        moved.update(cx, |rt, cx| {
            let next = (!disabled).then_some(idx);
            if rt.highlight != next {
                rt.highlight = next;
                cx.notify();
            }
        });
    })
    .on_hover(move |hovered, _, cx| {
        if !*hovered {
            left.update(cx, |rt, cx| {
                if rt.highlight == Some(idx) {
                    rt.highlight = None;
                    cx.notify();
                }
            });
        }
    })
}

/// `SelectLabel`: padding `xs sm`, secondary, `--font-size-1`.
fn label(ds: &Ds, text: &SharedString) -> AnyElement {
    div()
        .flex_none()
        .px(ds.len(Length::SpaceSm))
        .py(ds.len(Length::SpaceXs))
        .text_color(ds.color(Color::TextSecondary))
        .text_size(ds.len(Length::FontSize1))
        .child(text.clone())
        .into_any_element()
}

/// `SelectScrollUpButton` and `SelectScrollDownButton`: they scroll by one item every 50ms
/// while the pointer is over them.
fn scroll_button(sel: &Select, ds: &Ds, way: Way, step: f32) -> AnyElement {
    let glyph = match way {
        Way::Up => Icon::ChevronUpIcon,
        Way::Down => Icon::ChevronDown,
    };
    let name = match way {
        Way::Up => "up",
        Way::Down => "down",
    };
    let (moved, pressed, left) = (sel.rt.clone(), sel.rt.clone(), sel.rt.clone());
    let anchor = format!("{}-scroll-{name}", sel.id);
    div()
        .id(SharedString::from(anchor.clone()))
        .debug_selector(move || anchor.clone())
        .flex()
        .flex_none()
        .justify_center()
        .p(ds.len(Length::SpaceXs))
        .text_color(ds.color(Color::TextSecondary))
        .child(icon(glyph, IconSize::Md, ds))
        .on_mouse_move(move |_, window, cx| {
            moved.update(cx, |rt, cx| {
                rt.highlight = None;
                cx.notify();
            });
            runtime::start_auto(&moved, way, step, window, cx);
        })
        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
            runtime::start_auto(&pressed, way, step, window, cx);
        })
        .on_hover(move |hovered, _, cx| {
            if !*hovered {
                left.update(cx, |rt, _| rt.stop_auto());
            }
        })
        .into_any_element()
}

/// The window-level listeners of press, drag and release (Radix registers them on the
/// document): a release in the capture phase, before the items', decides whether it selects.
fn pointer_guard(sel: &Select) -> Div {
    let (rt, select, content) = (sel.rt.clone(), sel.clone(), sel.parts.content.clone());
    div().absolute().size_0().child(
        canvas(
            |_, _, _| (),
            move |_, (), window, _| {
                let moved = rt.clone();
                window.on_mouse_event(move |event: &MouseMoveEvent, _, _, cx| {
                    moved.update(cx, |rt, _| rt.track_pointer(event.position));
                });
                let (released, closer, inside) = (rt.clone(), select.clone(), content.clone());
                window.on_mouse_event(move |event: &MouseUpEvent, phase, window, cx| {
                    if !phase.capture() {
                        return;
                    }
                    let within = inside
                        .bounds()
                        .is_some_and(|bounds| bounds.contains(&event.position));
                    if released.update(cx, |rt, _| rt.release(event.position, within)) {
                        closer.set_open(false, window, cx);
                    }
                });
                let pressed = rt.clone();
                window.on_mouse_event(move |_: &MouseDownEvent, phase, _, cx| {
                    if phase.capture() {
                        pressed.update(cx, |rt, _| rt.forget_suppressed());
                    }
                });
            },
        )
        .size_0(),
    )
}
