//! The cells of ActivityHeatmap, the cursor they share (the hovered cell and the roving tab stop)
//! and the keys that move it (`useHeatmapFocus.ts`).
use std::rc::Rc;

use gpui::{
    AnyElement, App, Div, ElementId, Entity, FocusHandle, Hsla, InteractiveElement as _,
    IntoElement as _, MouseButton, ParentElement as _, Pixels, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, point, px,
};

use super::{ActivityHeatmapDay, HeatmapCell};
use crate::tokens::{Color, Length, Number};
use crate::ui::context::Ds;
use crate::ui::focus;
use crate::ui::tooltip::Tooltip;

pub(super) type Handler = Rc<dyn Fn(&str, &mut Window, &mut App)>;

/// The shaded square inside a default cell (DS: ActivityHeatmap.module.css:97).
const DOT: f32 = 16.;
/// The radius of a compact cell (DS: ActivityHeatmap.module.css:112), divided by the UI scale.
const COMPACT_RADIUS: f32 = 3.;
/// The selected ring's distance from the square: offset 2 plus the 1px line.
const SELECTED_REACH: f32 = 3.;

#[derive(Default)]
pub(super) struct Cursor {
    pub(super) hover: Option<usize>,
    pub(super) focus: Option<usize>,
}

/// Changes the cursor and repaints only when it moved.
pub(super) fn update(cursor: &Entity<Cursor>, cx: &mut App, change: impl FnOnce(&mut Cursor)) {
    cursor.update(cx, |cursor, cx| {
        let before = (cursor.hover, cursor.focus);
        change(cursor);
        if before != (cursor.hover, cursor.focus) {
            cx.notify();
        }
    });
}

/// `--heatmap-cell`, `--heatmap-gap` and the corner radius they imply.
#[derive(Clone, Copy)]
pub(super) struct Geometry {
    pub(super) cell: Pixels,
    pub(super) gap: Pixels,
    radius: Pixels,
    inner: Pixels,
    compact: bool,
}

impl Geometry {
    pub(super) fn new(kind: HeatmapCell, ds: &Ds) -> Self {
        let compact = kind == HeatmapCell::Compact;
        let control = ds.len(Length::RadiusControl);
        let small = px(COMPACT_RADIUS / ds.number(Number::UiScale));
        Self {
            // DS: ActivityHeatmap.module.css:5,15,16 (cell 24 or 10, gap 0 or 3)
            cell: px(if compact { 10. } else { 24. }),
            gap: px(if compact { 3. } else { 0. }),
            radius: if compact { small } else { control },
            inner: if compact { small } else { control / 4. },
            compact,
        }
    }

    pub(super) fn pitch(&self) -> Pixels {
        self.cell + self.gap
    }
}

enum Shade {
    Unknown,
    Level(u8),
}

/// `dayLevel`: the screen's level, or the count bands.
fn shade(day: &ActivityHeatmapDay) -> Shade {
    let Some(count) = day.count else {
        return Shade::Unknown;
    };
    Shade::Level(day.level.unwrap_or(match count {
        0 => 0,
        1 => 1,
        2..=4 => 2,
        5..=9 => 3,
        _ => 4,
    }))
}

/// The square's fill: the steps darken with intensity in light and brighten in dark.
pub(super) fn fill(level: u8, ds: &Ds) -> Hsla {
    let steps = if ds.dark() {
        [Color::Blue08, Color::Blue06, Color::Blue04, Color::Blue02]
    } else {
        [Color::Blue02, Color::Blue04, Color::Blue06, Color::Blue08]
    };
    match level {
        0 => ds.color(Color::Selection),
        n => ds.color(steps[usize::from(n.min(4)) - 1]),
    }
}

/// The square of a cell (also the legend's swatch): `unknown` is a dashed outline.
pub(super) fn square(unknown: bool, level: u8, geo: Geometry, ds: &Ds) -> Div {
    let side = if geo.compact { geo.cell } else { px(DOT) };
    let square = div().relative().flex_none().size(side).rounded(geo.inner);
    if unknown {
        square
            .border(ds.len(Length::BorderHairline))
            .border_dashed()
            .border_color(ds.color(Color::TextTertiary))
    } else {
        square.bg(fill(level, ds))
    }
}

/// A `Div` the size of one cell, centring its content.
pub(super) fn slot(geo: Geometry) -> Div {
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(geo.cell)
}

/// `dayLabel`: the label, and the count's words after it.
pub(super) fn day_label(day: &ActivityHeatmapDay) -> SharedString {
    match (day.count, &day.count_label) {
        (None, _) => day.label.clone(),
        (Some(_), Some(words)) => format!("{} · {words}", day.label).into(),
        (Some(count), None) => format!("{} · {count}", day.label).into(),
    }
}

/// What every cell of one render shares.
pub(super) struct Grid {
    pub(super) base: SharedString,
    pub(super) geo: Geometry,
    /// The roving tab stop.
    pub(super) tab: usize,
    /// The tab stop shows its focus ring (the grid has the keyboard focus).
    pub(super) ring: bool,
    /// The cell under the pointer.
    pub(super) hover: Option<usize>,
    /// The cell whose tooltip is open.
    pub(super) active: Option<usize>,
    pub(super) selected: Option<SharedString>,
    pub(super) on_select: Option<Handler>,
    pub(super) cursor: Entity<Cursor>,
    pub(super) handle: FocusHandle,
}

impl Grid {
    /// One day.
    pub(super) fn cell(&self, day: &ActivityHeatmapDay, index: usize, ds: &Ds) -> AnyElement {
        // ANIM-MIGRATE(a shade change runs as a wave: `background-color` over --motion-base,
        // delayed by column * 4ms + (6 - row) * 18ms, left to right and bottom up; the hover
        // line fades over --motion-fast)
        let level = match shade(day) {
            Shade::Unknown => None,
            Shade::Level(level) => Some(level),
        };
        let selected = self.on_select.is_some() && self.selected.as_ref() == Some(&day.id);
        let mut square = square(level.is_none(), level.unwrap_or(0), self.geo, ds);
        if self.hover == Some(index) {
            let line = ds.color(Color::TextTertiary);
            square = square.child(overlay(0., line, self.geo.inner).size_full());
        }
        if selected {
            let reach = px(SELECTED_REACH);
            let side = square_side(self.geo) + reach * 2.;
            let line = ds.color(Color::TextPrimary);
            let ring = overlay(-SELECTED_REACH, line, self.geo.inner + reach).size(side);
            square = square.child(ring);
        }
        let mut cell = slot(self.geo)
            .id(ElementId::from((self.base.clone(), index)))
            .rounded(self.geo.radius)
            .child(square);
        if self.ring && self.tab == index {
            cell = cell.shadow(focus::shadows(ds));
        }
        let cursor = self.cursor.clone();
        let handle = self.handle.clone();
        cell = cell
            .on_hover({
                let cursor = cursor.clone();
                move |on, _, cx| {
                    update(&cursor, cx, |c| {
                        if *on {
                            c.hover = Some(index);
                        } else if c.hover == Some(index) {
                            c.hover = None;
                        }
                    });
                }
            })
            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                window.focus(&handle, cx);
                update(&cursor, cx, |c| c.focus = Some(index));
            });
        if let Some(on_select) = self.on_select.clone() {
            let id = day.id.clone();
            cell = cell
                .cursor_pointer()
                .on_click(move |_, window, cx| on_select(&id, window, cx));
        }
        if self.active == Some(index) {
            return Tooltip::new((ElementId::from(self.base.clone()), "tip"))
                .open(true)
                .label(day_label(day))
                .child(cell)
                .into_any_element();
        }
        cell.into_any_element()
    }
}

fn square_side(geo: Geometry) -> Pixels {
    if geo.compact { geo.cell } else { px(DOT) }
}

/// A line drawn over the square, `inset` px past its edge.
fn overlay(inset: f32, color: Hsla, radius: Pixels) -> Div {
    div()
        .absolute()
        .top(px(inset))
        .left(px(inset))
        .rounded(radius)
        .border(px(1.))
        .border_color(color)
}

/// `KEY_STEPS`, Home and End: the cell a key moves to, if it moves.
pub(super) fn target(key: &str, from: usize, len: usize) -> Option<usize> {
    let next = match key {
        "up" => from.checked_sub(1)?,
        "down" => from + 1,
        "left" => from.checked_sub(7)?,
        "right" => from + 7,
        "home" => 0,
        "end" => len.checked_sub(1)?,
        _ => return None,
    };
    (next < len).then_some(next)
}

/// Scrolls cell `index` into the viewport (a browser does it on focus).
#[expect(clippy::cast_precision_loss, reason = "a week column")]
pub(super) fn reveal(scroll: &ScrollHandle, index: usize, offset: usize, geo: Geometry) {
    let column = (index + offset) / 7;
    let left = geo.pitch() * column as f32;
    let right = left + geo.cell;
    let view = scroll.bounds().size.width;
    let from = -scroll.offset().x;
    let to = if left < from {
        left
    } else if right > from + view {
        right - view
    } else {
        return;
    };
    scroll.set_offset(point(-to, scroll.offset().y));
}
