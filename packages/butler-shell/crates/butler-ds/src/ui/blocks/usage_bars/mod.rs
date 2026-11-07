//! DS UsageBars (UsageBars.tsx / UsageBars.module.css / useUsageBarsSelection.ts): stacked usage
//! columns over time: a 56px popover strip or a panel chart with y ticks. Presenter only: buckets,
//! series colours, labels and copy come from the caller; the selected bucket's readout lives in
//! the caller (no tooltip). One tab stop; arrows move the selection. A segment's `subtask` part
//! is drawn hatched on top of it; `emphasis` follows a linked legend row.
mod buckets;
mod draw;
mod layout;
mod motion;
mod parts;

use std::rc::Rc;

use gpui::{
    App, Bounds, ElementId, InteractiveElement as _, IntoElement, ParentElement as _, Pixels,
    RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, px,
};

pub use buckets::{
    Bucketing, Options as BucketOptions, SLOT_MS, Slot, TimeBucket, bucket_usage_slots,
    civil_from_days, day_and_hour, wall_ms,
};

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::{blocks::measure, focus};

/// `UsageBarsColor`: a chart token (`--context-chart-1` to `-6`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeriesColor {
    Chart1,
    Chart2,
    Chart3,
    Chart4,
    Chart5,
    Chart6,
}

impl SeriesColor {
    fn token(self) -> Color {
        match self {
            Self::Chart1 => Color::ContextChart1,
            Self::Chart2 => Color::ContextChart2,
            Self::Chart3 => Color::ContextChart3,
            Self::Chart4 => Color::ContextChart4,
            Self::Chart5 => Color::ContextChart5,
            Self::Chart6 => Color::ContextChart6,
        }
    }
}

/// `popover`: 56px plot, columns up to 14px. `panel`: `--chart-height-panel`, columns up to 24px.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Size {
    #[default]
    Popover,
    Panel,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum State {
    #[default]
    Ready,
    Loading,
    Empty,
}

/// Linked-legend emphasis: `Subtask` strengthens the hatch, `Conversation` dims the hatched parts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Emphasis {
    Conversation,
    Subtask,
}

/// One stacked series; the series order is the stacking order, bottom first.
#[derive(Clone, Debug)]
pub struct Series {
    pub id: SharedString,
    pub color: SeriesColor,
    pub label: SharedString,
}

#[derive(Clone, Debug)]
pub struct Segment {
    pub id: SharedString,
    pub value: f64,
    /// Part of `value` that came from subtasks (0 to `value`), drawn hatched on top.
    pub subtask: f64,
}

#[derive(Clone, Debug)]
pub struct Bucket {
    pub key: SharedString,
    pub segments: Vec<Segment>,
    /// The bucket's name for the caller's readout ("14:00-15:00").
    pub label: SharedString,
    /// The formatted value of the bucket ("12.4K tokens").
    pub value_text: SharedString,
}

#[derive(Clone, Debug)]
pub struct AxisLabel {
    pub index: usize,
    pub text: SharedString,
}

/// Who owns the selected bucket: the block itself, or the caller.
#[derive(Clone, Copy, Debug)]
enum Selection {
    Own,
    Controlled(Option<usize>),
}

type Select = Rc<dyn Fn(Option<usize>, &mut Window, &mut App)>;
type Format = Rc<dyn Fn(f64) -> String>;

#[derive(IntoElement)]
pub struct UsageBars {
    id: ElementId,
    buckets: Vec<Bucket>,
    series: Vec<Series>,
    size: Size,
    state: State,
    selected: Selection,
    on_select: Option<Select>,
    axis_labels: Vec<AxisLabel>,
    min_slots: usize,
    y_ticks: Option<Format>,
    empty_label: Option<SharedString>,
    note: Option<SharedString>,
    emphasis: Option<Emphasis>,
}

impl UsageBars {
    pub fn new(id: impl Into<ElementId>, buckets: Vec<Bucket>, series: Vec<Series>) -> Self {
        Self {
            id: id.into(),
            buckets,
            series,
            size: Size::Popover,
            state: State::Ready,
            selected: Selection::Own,
            on_select: None,
            axis_labels: Vec::new(),
            min_slots: 8, // DS: UsageBars.tsx:26
            y_ticks: None,
            empty_label: None,
            note: None,
            emphasis: None,
        }
    }

    pub fn size(mut self, size: Size) -> Self {
        self.size = size;
        self
    }

    pub fn state(mut self, state: State) -> Self {
        self.state = state;
        self
    }

    /// Controlled selection; omit to let the block keep its own.
    pub fn selected(mut self, selected: Option<usize>) -> Self {
        self.selected = Selection::Controlled(selected);
        self
    }

    /// Hover, arrow keys, Home, End and Esc report the selected bucket here (none clears).
    pub fn on_select(
        mut self,
        handler: impl Fn(Option<usize>, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_select = Some(Rc::new(handler));
        self
    }

    pub fn axis_labels(mut self, labels: Vec<AxisLabel>) -> Self {
        self.axis_labels = labels;
        self
    }

    /// The plot keeps at least this many column slots, so a few buckets do not stretch.
    pub fn min_slots(mut self, slots: usize) -> Self {
        self.min_slots = slots;
        self
    }

    /// Panel only: faint half and top gridlines with their values in a left gutter.
    pub fn y_ticks(mut self, format: impl Fn(f64) -> String + 'static) -> Self {
        self.y_ticks = Some(Rc::new(format));
        self
    }

    /// Text centred in the plot when empty (state empty, or every bucket is zero).
    pub fn empty_label(mut self, label: impl Into<SharedString>) -> Self {
        self.empty_label = Some(label.into());
        self
    }

    /// One muted caption after the last bar; for a few buckets only.
    pub fn note(mut self, note: impl Into<SharedString>) -> Self {
        self.note = Some(note.into());
        self
    }

    pub fn emphasis(mut self, emphasis: Option<Emphasis>) -> Self {
        self.emphasis = emphasis;
        self
    }
}

/// What a navigation key does to the selection.
enum Nav {
    To(usize),
    Clear,
}

impl Nav {
    fn index(self) -> Option<usize> {
        match self {
            Self::To(index) => Some(index),
            Self::Clear => None,
        }
    }
}

/// What a navigation key does, or none when the key is not ours.
fn key_target(key: &str, current: Option<usize>, count: usize) -> Option<Nav> {
    match key {
        "right" => Some(Nav::To(current.map_or(0, |at| (at + 1).min(count - 1)))),
        "left" => Some(Nav::To(
            current.map_or(count - 1, |at| at.saturating_sub(1)),
        )),
        "home" => Some(Nav::To(0)),
        "end" => Some(Nav::To(count - 1)),
        // Esc with nothing selected stays with the surrounding surface (closes a popover).
        "escape" if current.is_some() => Some(Nav::Clear),
        _ => None,
    }
}

type Selector = Rc<dyn Fn(Option<usize>, &mut Window, &mut App)>;

/// The selection setter: keeps the block's own state unless controlled, then tells the caller.
fn selector(
    own: gpui::Entity<Option<usize>>,
    controlled: bool,
    on_select: Option<Select>,
) -> Selector {
    Rc::new(move |next, window, cx| {
        if !controlled {
            own.update(cx, |own, cx| {
                *own = next;
                cx.notify();
            });
        }
        if let Some(on_select) = &on_select {
            on_select(next, window, cx);
        }
    })
}

/// The height (px) each column grows to, or none while the chart is not ready.
fn column_targets(
    geometry: &layout::Geometry,
    ready: bool,
    plot_h: f32,
    headroom: f32,
) -> Vec<f32> {
    if !ready {
        return Vec::new();
    }
    geometry
        .columns
        .iter()
        .map(|column| {
            if column.total > 0. {
                (layout::narrow(column.fraction) * (plot_h - headroom)).max(2.)
            } else {
                0.
            }
        })
        .collect()
}

/// The plot's pointer handling: hover selects the bucket under the pointer, leaving clears it.
fn with_pointer(
    plot: gpui::Stateful<gpui::Div>,
    bounds: gpui::Entity<Bounds<Pixels>>,
    select: &Selector,
    handle: gpui::FocusHandle,
    (slots, count, selected): (usize, usize, Option<usize>),
) -> gpui::Stateful<gpui::Div> {
    let (move_select, leave_select) = (select.clone(), select.clone());
    plot.on_mouse_move(move |event, window, cx| {
        let area = *bounds.read(cx);
        let at = layout::bucket_at(
            f32::from(event.position.x),
            f32::from(area.origin.x),
            f32::from(area.size.width),
            slots,
            count,
        );
        if at != selected {
            move_select(at, window, cx);
        }
    })
    .on_hover(move |hovered, window, cx| {
        if !*hovered && !handle.is_focused(window) {
            leave_select(None, window, cx);
        }
    })
}

/// The focus ring drawn around the block, outside its box.
fn focus_ring(ds: &Ds, radius: Pixels) -> gpui::Div {
    let room = focus::room(ds);
    div()
        .absolute()
        .top(-room)
        .left(-room)
        .right(-room)
        .bottom(-room)
        .rounded(radius + room)
        .border(ds.len(Length::FocusRingWidth))
        .border_color(ds.color(Color::ColorActionPrimary))
}

impl RenderOnce for UsageBars {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ticks = self.size == Size::Panel && self.y_ticks.is_some();
        let shown: &[Bucket] = if self.state == State::Ready {
            &self.buckets
        } else {
            &[]
        };
        let geometry = layout::geometry(
            shown,
            &self.series,
            self.min_slots.max(self.buckets.len()),
            ticks,
            self.size,
        );
        let ready = self.state == State::Ready && !geometry.blank;
        let count = if ready { geometry.columns.len() } else { 0 };
        let own = window.use_keyed_state((self.id.clone(), "selected"), cx, |_, _| None::<usize>);
        let selected = match self.selected {
            Selection::Own => *own.read(cx),
            Selection::Controlled(selected) => selected,
        }
        .filter(|index| *index < count);
        let plot_bounds = window.use_keyed_state((self.id.clone(), "bounds"), cx, |_, _| {
            Bounds::<Pixels>::default()
        });
        let handle = window
            .use_keyed_state((self.id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
            .read(cx)
            .clone();
        let controlled = matches!(self.selected, Selection::Controlled(_));
        let select = selector(own, controlled, self.on_select.clone());
        let plot_h = layout::draw_height(self.size);
        let headroom = if ticks { layout::TICK_HEADROOM } else { 0. };
        let targets = column_targets(&geometry, ready, plot_h, headroom);
        let drawn = motion::heights(&self.id, &targets, window, cx);
        let frame = parts::Frame {
            geometry: &geometry,
            drawn: &drawn,
            selected,
            ready,
            plot_h,
            headroom,
        };
        let y_labels = self.y_labels(&frame);
        let gutter = y_labels
            .iter()
            .map(|(_, text)| measure::text_width(text, Length::TypoCaptionSize, window, cx))
            .fold(0., f32::max);
        let plot = self.plot(&frame, &plot_bounds, Ds::get(cx), window);
        let axis = self.axis(&frame, window, cx);
        let ds = Ds::get(cx);
        let plot = if ready {
            let shape = (geometry.slots, count, selected);
            with_pointer(plot, plot_bounds.clone(), &select, handle.clone(), shape)
        } else {
            plot
        };
        let focused = focus::visible(ds, handle.is_focused(window), false);
        let radius = px(if self.size == Size::Panel { 4. } else { 2. });
        let sm = ds.len(Length::SpaceSm);
        let mut root = div()
            .id(self.id.clone())
            .relative()
            .flex()
            .flex_col()
            .gap(ds.len(Length::SpaceXs))
            .min_w_0()
            .rounded(radius);
        if ready {
            let keys = select.clone();
            root = root
                .track_focus(&focus::tab_stop(&handle, true))
                .on_key_down(move |event, window, cx| {
                    if let Some(next) = key_target(event.keystroke.key.as_str(), selected, count) {
                        cx.stop_propagation();
                        keys(next.index(), window, cx);
                    }
                });
        }
        let ring_box = focused.then(|| focus_ring(ds, radius));
        let body = if ticks {
            div()
                .flex()
                .gap(sm)
                .child(draw::y_axis(&y_labels, gutter, plot_h, ds))
                .child(div().flex_1().min_w_0().child(plot))
                .into_any_element()
        } else {
            plot.into_any_element()
        };
        let axis = div()
            .pl(if ticks { px(gutter) + sm } else { px(0.) })
            .child(axis);
        root.children(ring_box).child(body).child(axis)
    }
}
