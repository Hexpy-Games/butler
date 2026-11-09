//! DS ActivityHeatmap (ActivityHeatmap.tsx / .module.css / useHeatmapFocus.ts): a calendar of
//! shaded days, one column per week, weekday labels pinned beside a horizontally scrolling grid
//! and a month axis over it. The grid is one tab stop: the arrows move by day and week, Home and
//! End jump, Enter and Space select. One shared tooltip opens over the hovered or focused day.
//!
//! CARVE-OUT(G-ds): `useFitCell` shrinks the cell under a larger App text size so every week
//! still shows; the cell stays at its base size here and the grid scrolls.
mod cells;

use std::rc::Rc;

use gpui::{
    App, Div, ElementId, InteractiveElement as _, IntoElement, ParentElement as _, Pixels,
    RenderOnce, SharedString, Styled as _, Window, div, point, px, relative,
};

use self::cells::{Cursor, Geometry, Grid, Handler, reveal, slot, square, target, update};
use crate::tokens::Length;
use crate::ui::context::Ds;
use crate::ui::focus;
use crate::ui::scroll::{Axis, Config, scroller};
use crate::ui::typo::{Tone, Typo, Wrap};

/// Months shorter than this many visible weeks keep their columns but drop the name.
const MIN_MONTH_WEEKS: usize = 3;
/// The legend's last swatch is the unavailable day.
const UNKNOWN_SWATCH: usize = 5;

/// One day. `count: None` is an unavailable day (a dashed cell).
#[derive(Clone, Debug)]
pub struct ActivityHeatmapDay {
    pub id: SharedString,
    pub label: SharedString,
    pub count: Option<u64>,
    /// The month name over the day's week; empty for none.
    pub month_label: SharedString,
    /// The count in words, after the label in the tooltip (the count itself by default).
    pub count_label: Option<SharedString>,
    /// Shade 0 to 4 computed by the screen; replaces the count bands when set.
    pub level: Option<u8>,
}

impl ActivityHeatmapDay {
    pub fn new(
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        count: Option<u64>,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            count,
            month_label: SharedString::default(),
            count_label: None,
            level: None,
        }
    }

    pub fn month_label(mut self, label: impl Into<SharedString>) -> Self {
        self.month_label = label.into();
        self
    }

    pub fn count_label(mut self, label: impl Into<SharedString>) -> Self {
        self.count_label = Some(label.into());
        self
    }

    pub fn level(mut self, level: u8) -> Self {
        self.level = Some(level);
        self
    }
}

/// `default` keeps 24px targets; `compact` draws 10px cells for a year at a glance.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum HeatmapCell {
    #[default]
    Default,
    Compact,
}

/// `end` opens scrolled to the latest week.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ScrollAnchor {
    #[default]
    Start,
    End,
}

#[derive(IntoElement)]
pub struct ActivityHeatmap {
    id: ElementId,
    days: Vec<ActivityHeatmapDay>,
    aria_label: Option<SharedString>,
    start_weekday: u8,
    weekday_labels: Vec<SharedString>,
    selected_id: Option<SharedString>,
    on_select: Option<Handler>,
    legend: Option<(SharedString, Vec<SharedString>)>,
    cell: HeatmapCell,
    anchor: ScrollAnchor,
}

impl ActivityHeatmap {
    pub fn new(id: impl Into<ElementId>, days: Vec<ActivityHeatmapDay>) -> Self {
        Self {
            id: id.into(),
            days,
            aria_label: None,
            start_weekday: 0,
            weekday_labels: Vec::new(),
            selected_id: None,
            on_select: None,
            legend: None,
            cell: HeatmapCell::Default,
            anchor: ScrollAnchor::Start,
        }
    }

    /// The accessible name of the group (gpui draws none of it).
    pub fn aria_label(mut self, label: impl Into<SharedString>) -> Self {
        self.aria_label = Some(label.into());
        self
    }

    /// The weekday of the first day, 0 (Sunday) to 6; the first column starts with that many gaps.
    pub fn start_weekday(mut self, weekday: u8) -> Self {
        self.start_weekday = weekday;
        self
    }

    /// Seven labels, one per row; an empty label skips its row.
    pub fn weekday_labels(mut self, labels: Vec<SharedString>) -> Self {
        self.weekday_labels = labels;
        self
    }

    pub fn selected_id(mut self, id: impl Into<SharedString>) -> Self {
        self.selected_id = Some(id.into());
        self
    }

    /// Makes the days selectable; the callback gets the day's id.
    pub fn on_select(mut self, handler: impl Fn(&str, &mut Window, &mut App) + 'static) -> Self {
        self.on_select = Some(Rc::new(handler));
        self
    }

    /// The shade key under the grid: `title` (empty for none) and one label per level, then the
    /// unavailable day as the sixth.
    pub fn legend(mut self, title: impl Into<SharedString>, labels: Vec<SharedString>) -> Self {
        self.legend = Some((title.into(), labels));
        self
    }

    pub fn cell(mut self, cell: HeatmapCell) -> Self {
        self.cell = cell;
        self
    }

    pub fn scroll_anchor(mut self, anchor: ScrollAnchor) -> Self {
        self.anchor = anchor;
        self
    }

    /// The accessible name, if one was set.
    pub fn label(&self) -> Option<&SharedString> {
        self.aria_label.as_ref()
    }
}

/// `monthSpans`: runs of weeks under one month name.
fn month_spans(
    days: &[ActivityHeatmapDay],
    offset: usize,
    weeks: usize,
) -> Vec<(SharedString, usize)> {
    let mut months: Vec<(SharedString, usize)> = Vec::new();
    for week in 0..weeks {
        let label = days
            .get((week * 7).saturating_sub(offset))
            .map(|day| day.month_label.clone())
            .unwrap_or_default();
        match months.last_mut() {
            Some((last, span)) if *last == label => *span += 1,
            _ => months.push((label, 1)),
        }
    }
    months
}

/// The month axis, one column per week.
#[expect(clippy::cast_precision_loss, reason = "a count of weeks")]
fn month_axis(spans: Vec<(SharedString, usize)>, geo: Geometry, compact: bool, ds: &Ds) -> Div {
    let line = ds.len(Length::TypoCaptionLineHeight);
    let pad = if compact {
        px(0.)
    } else {
        ds.len(Length::SpaceXs)
    };
    let columns = spans.into_iter().map(|(label, span)| {
        let width = geo.cell * span as f32 + geo.gap * (span - 1) as f32;
        let text = (span >= MIN_MONTH_WEEKS && !label.is_empty()).then(|| {
            Typo::caption(label)
                .tone(Tone::Secondary)
                .wrap(Wrap::Nowrap)
        });
        div()
            .flex_none()
            .w(width)
            .h(line)
            .px(pad)
            .overflow_hidden()
            .children(text)
    });
    div().flex().flex_none().gap(geo.gap).children(columns)
}

/// The weekday labels, pinned beside the scroller.
fn weekday_axis(labels: Vec<SharedString>, months: bool, geo: Geometry, ds: &Ds) -> Div {
    let xs = ds.len(Length::SpaceXs);
    let rows = labels.into_iter().map(|label| {
        let text = Typo::caption(label).tone(Tone::Tertiary).wrap(Wrap::Nowrap);
        div()
            .flex()
            .items_center()
            .flex_none()
            .h(geo.cell)
            .child(text)
    });
    let spacer = months.then(|| {
        div()
            .flex_none()
            .h(ds.len(Length::TypoCaptionLineHeight) + xs - geo.gap)
    });
    div()
        .flex()
        .flex_col()
        .flex_none()
        .gap(geo.gap)
        .py(xs + focus::room(ds))
        .children(spacer)
        .children(rows)
}

/// The shade key: a swatch and its words per level.
fn legend(title: SharedString, labels: Vec<SharedString>, geo: Geometry, ds: &Ds) -> Div {
    let items = labels.into_iter().enumerate().map(|(index, label)| {
        let swatch = slot(geo).child(square(
            index == UNKNOWN_SWATCH,
            u8::try_from(index).unwrap_or(4).min(4),
            geo,
            ds,
        ));
        div()
            .flex()
            .items_center()
            .gap(ds.len(Length::SpaceXs))
            .child(swatch)
            .child(
                Typo::caption(label)
                    .tone(Tone::Secondary)
                    .wrap(Wrap::Nowrap),
            )
    });
    let title = (!title.is_empty()).then(|| {
        div()
            .mb(ds.len(Length::SpaceXs))
            .child(Typo::caption(title).tone(Tone::Secondary))
    });
    div().mt(ds.len(Length::SpaceMd)).children(title).child(
        div()
            .flex()
            .flex_wrap()
            .gap_x(ds.len(Length::SpaceMd))
            .gap_y(ds.len(Length::SpaceXs))
            .children(items),
    )
}

/// The keys of the grid: the roving tab stop, and the selection.
struct Keys {
    handle: gpui::FocusHandle,
    cursor: gpui::Entity<Cursor>,
    scroll: gpui::ScrollHandle,
    ids: Vec<SharedString>,
    on_select: Option<Handler>,
    tab: usize,
    offset: usize,
    geo: Geometry,
}

impl Keys {
    fn press(&self, event: &gpui::KeyDownEvent, window: &mut Window, cx: &mut App) {
        let len = self.ids.len();
        if len == 0 || !self.handle.is_focused(window) {
            return;
        }
        let key = event.keystroke.key.as_str();
        if let Some(next) = target(key, self.tab, len) {
            cx.stop_propagation();
            update(&self.cursor, cx, |cursor| cursor.focus = Some(next));
            reveal(&self.scroll, next, self.offset, self.geo);
        } else if matches!(key, "enter" | "space")
            && let (Some(select), Some(id)) = (&self.on_select, self.ids.get(self.tab))
        {
            cx.stop_propagation();
            select(id, window, cx);
        }
    }
}

impl ActivityHeatmap {
    /// The week columns of the grid: gaps for the start weekday, then the days.
    fn columns(&self, offset: usize, weeks: usize, grid: &Grid, ds: &Ds) -> Vec<Div> {
        (0..weeks)
            .map(|week| {
                let cells = (0..7).filter_map(|row| {
                    let position = week * 7 + row;
                    if position < offset {
                        return Some(div().flex_none().size(grid.geo.cell).into_any_element());
                    }
                    let day = self.days.get(position - offset)?;
                    Some(grid.cell(day, position - offset, ds))
                });
                div()
                    .flex()
                    .flex_col()
                    .flex_none()
                    .gap(grid.geo.gap)
                    .children(cells)
            })
            .collect()
    }

    /// The shared grid state: the tab stop, the ring, the pointer cell and the selection.
    fn grid(
        &self,
        cursor: &gpui::Entity<Cursor>,
        handle: &gpui::FocusHandle,
        (tab, ring, hover): (usize, bool, Option<usize>),
        geo: Geometry,
    ) -> Grid {
        Grid {
            base: SharedString::from(self.id.to_string()),
            geo,
            tab,
            ring,
            hover,
            active: hover.or(ring.then_some(tab)),
            selected: self.selected_id.clone(),
            on_select: self.on_select.clone(),
            cursor: cursor.clone(),
            handle: handle.clone(),
        }
    }

    /// The month axis over the grid, inside the scroller's padding.
    fn calendar(&self, grid: &Grid, offset: usize, weeks: usize, ds: &Ds) -> Div {
        let xs = ds.len(Length::SpaceXs);
        let body = div()
            .id((self.id.clone(), "grid"))
            .flex()
            .flex_none()
            .gap(grid.geo.gap)
            .track_focus(&focus::tab_stop(&grid.handle, true))
            .children(self.columns(offset, weeks, grid, ds));
        let mut calendar = div()
            .flex()
            .flex_col()
            .flex_none()
            .min_w(relative(1.))
            .gap(xs)
            .py(xs + focus::room(ds))
            .px(focus::room(ds));
        if self.days.iter().any(|day| !day.month_label.is_empty()) {
            let spans = month_spans(&self.days, offset, weeks);
            calendar = calendar.child(month_axis(
                spans,
                grid.geo,
                self.cell == HeatmapCell::Compact,
                ds,
            ));
        }
        calendar.child(body)
    }
}

impl RenderOnce for ActivityHeatmap {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let cursor =
            window.use_keyed_state((self.id.clone(), "cursor"), cx, |_, _| Cursor::default());
        let handle = window
            .use_keyed_state((self.id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
            .read(cx)
            .clone();
        let anchored = window.use_keyed_state((self.id.clone(), "anchored"), cx, |_, _| 0_usize);
        let len = self.days.len();
        let offset = usize::from(self.start_weekday.min(6));
        let weeks = (offset + len).div_ceil(7);
        let end = self.anchor == ScrollAnchor::End;
        let selected = self
            .days
            .iter()
            .position(|day| Some(&day.id) == self.selected_id.as_ref());
        let initial = selected.unwrap_or(if end { len.saturating_sub(1) } else { 0 });
        let (hover, focus) = (cursor.read(cx).hover, cursor.read(cx).focus);
        let tab = focus.unwrap_or(initial).min(len.saturating_sub(1));
        let focused = handle.is_focused(window);
        let ds = Ds::get(cx);
        let ring = len > 0 && focus::visible(ds, focused, false);
        let geo = Geometry::new(self.cell, ds);
        let grid = self.grid(&cursor, &handle, (tab, ring, hover), geo);
        let calendar = self.calendar(&grid, offset, weeks, ds);
        let has_months = self.days.iter().any(|day| !day.month_label.is_empty());
        let weekdays = (!self.weekday_labels.is_empty())
            .then(|| weekday_axis(self.weekday_labels.clone(), has_months, geo, ds));
        let key = self
            .legend
            .clone()
            .map(|(title, labels)| legend(title, labels, geo, ds));
        let xs = ds.len(Length::SpaceXs);
        let config = Config {
            id: self.id.clone(),
            axis: Axis::X,
            size: ds.len(Length::ScrollFadeSize),
            guard: xs,
        };
        let built = scroller(&config, calendar, window, cx);
        if end && *anchored.read(cx) != weeks {
            // The scroll position clamps to the farthest the grid goes when it lays out.
            built.handle.set_offset(point(px(-1e7), px(0.)));
            anchored.update(cx, |anchored, _| *anchored = weeks);
        }
        let keys = Keys {
            handle,
            cursor,
            scroll: built.handle.clone(),
            ids: self.days.iter().map(|day| day.id.clone()).collect(),
            on_select: self.on_select.clone(),
            tab,
            offset,
            geo,
        };
        let viewport = div()
            .relative()
            .flex_1()
            .min_w_0()
            .overflow_hidden()
            .child(built.element);
        frame(self.id, (weekdays, viewport, key), keys, xs)
    }
}

/// The heatmap's outer box: the weekday labels beside the scroller, the key under them.
fn frame(
    id: ElementId,
    (weekdays, viewport, key): (Option<Div>, Div, Option<Div>),
    keys: Keys,
    gap: Pixels,
) -> impl IntoElement {
    div()
        .id(id)
        .flex()
        .flex_col()
        .min_w_0()
        .on_key_down(move |event, window, cx| keys.press(event, window, cx))
        .child(
            div()
                .flex()
                .gap(gap)
                .min_w_0()
                .children(weekdays)
                .child(viewport),
        )
        .children(key)
}
