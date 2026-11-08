//! The TimePicker popover body (TimeColumns.tsx): one wheel column per segment. A wheel shows five
//! rows with the selected value always on the centre one, so every column lines up. React scrolls
//! a snapping list; here the five rows are drawn around the selected index, and a click, the
//! arrow keys or the mouse wheel move the selection.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, Entity, FocusHandle, FontWeight, InteractiveElement as _,
    IntoElement as _, ParentElement as _, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window, div,
};

use super::model::{Choice, Parts, Segment, apply, choices, selected};
use super::{Ctx, sub};
use crate::tokens::{Color, Length, Number};
use crate::ui::context::Ds;
use crate::ui::focus;

/// Rows above and below the selected one.
const SIDE_ROWS: i32 = 2;

/// Enter, Space, or a tapped minute: close, and hand focus back to the field.
#[derive(Clone)]
pub(super) struct Done {
    pub(super) returning: Entity<bool>,
    pub(super) ctx: Ctx,
}

impl Done {
    fn run(&self, window: &mut Window, cx: &mut App) {
        self.returning.update(cx, |flag, _| *flag = true);
        self.ctx.popover.set_open(false, window, cx);
    }
}

/// The focus handle of a column.
pub(super) fn column_handle(
    id: &ElementId,
    segment: Segment,
    window: &mut Window,
    cx: &mut App,
) -> FocusHandle {
    window
        .use_keyed_state(sub(id, "column", segment.key()), cx, |_, cx| {
            cx.focus_handle()
        })
        .read(cx)
        .clone()
}

/// What one column needs besides the context.
struct Wheel {
    segment: Segment,
    options: Rc<Vec<Choice>>,
    index: usize,
    handle: FocusHandle,
    sides: (Option<FocusHandle>, Option<FocusHandle>),
    scrolled: Entity<f32>,
}

pub(super) fn columns(
    ctx: &Ctx,
    minute_step: i32,
    done: &Done,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let order = ctx.layout.order;
    let handles: Vec<FocusHandle> = order
        .iter()
        .map(|segment| column_handle(&ctx.id, *segment, window, cx))
        .collect();
    let wheels: Vec<Wheel> = order
        .iter()
        .enumerate()
        .map(|(at, segment)| {
            let options = Rc::new(choices(
                *segment,
                ctx.cycle,
                &ctx.layout,
                minute_step,
                ctx.parts.minutes,
            ));
            let value = selected(*segment, ctx.cycle, ctx.parts);
            let index = options.iter().position(|o| o.value == value).unwrap_or(0);
            Wheel {
                segment: *segment,
                options,
                index,
                handle: handles[at].clone(),
                sides: (
                    at.checked_sub(1).and_then(|i| handles.get(i)).cloned(),
                    handles.get(at + 1).cloned(),
                ),
                scrolled: window.use_keyed_state(
                    sub(&ctx.id, "wheel", segment.key()),
                    cx,
                    |_, _| 0.,
                ),
            }
        })
        .collect();
    let ds = Ds::get(cx);
    div()
        .flex()
        .w_full()
        .gap(ds.len(Length::SpaceXs)) // DS: TimePicker.module.css:104
        .children(
            wheels
                .into_iter()
                .map(|wheel| column(ctx, done, &wheel, window, ds)),
        )
        .into_any_element()
}

type Pick = Rc<dyn Fn(i32, bool, &mut Window, &mut App)>;

/// A pick sets the value; a tapped minute also finishes.
fn pick_with(ctx: &Ctx, done: &Done, segment: Segment) -> Pick {
    let (ctx, done) = (ctx.clone(), done.clone());
    Rc::new(move |value, tapped, window, cx| {
        let next: Parts = apply(segment, ctx.cycle, ctx.parts, value);
        (ctx.set)(next, window, cx);
        if tapped && segment == Segment::Minute {
            done.run(window, cx);
        }
    })
}

fn column(ctx: &Ctx, done: &Done, wheel: &Wheel, window: &Window, ds: &Ds) -> AnyElement {
    let row = ds.len(Length::MenuItemHeight);
    let pick = pick_with(ctx, done, wheel.segment);
    let ringed = focus::visible(ds, wheel.handle.is_focused(window), false);
    let rows = (-SIDE_ROWS..=SIDE_ROWS).map(|offset| {
        let at = i32::try_from(wheel.index).unwrap_or(0) + offset;
        let option = usize::try_from(at)
            .ok()
            .and_then(|at| wheel.options.get(at));
        option_row(ctx, wheel, option, offset == 0 && ringed, &pick, ds)
    });
    let rows: Vec<AnyElement> = rows.collect();
    let name = div()
        .text_center()
        .text_color(ds.color(Color::TextTertiary))
        .text_size(ds.len(Length::TypoCaptionSize))
        .line_height(ds.len(Length::TypoCaptionLineHeight))
        .child(ctx.layout.name(wheel.segment));
    let body = div()
        .id(sub(&ctx.id, "wheel-body", wheel.segment.key()))
        .track_focus(&focus::tab_stop(&wheel.handle, true))
        .flex()
        .flex_col()
        .h(row * (2 * SIDE_ROWS + 1) as f32)
        .overflow_hidden()
        .on_key_down(key_handler(wheel, done.clone(), pick.clone()))
        .on_scroll_wheel(wheel_handler(wheel, pick, row))
        .children(rows);
    div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .gap(ds.len(Length::SpaceXs))
        .child(name)
        .child(body)
        .into_any_element()
}

fn option_row(
    ctx: &Ctx,
    wheel: &Wheel,
    option: Option<&Choice>,
    ring: bool,
    pick: &Pick,
    ds: &Ds,
) -> AnyElement {
    let row = div().flex().flex_none().h(ds.len(Length::MenuItemHeight));
    let Some(option) = option else {
        return row.into_any_element();
    };
    let chosen = wheel
        .options
        .get(wheel.index)
        .is_some_and(|o| o.value == option.value);
    let value = option.value;
    let pick = pick.clone();
    let id = SharedString::from(format!("{}-{}-{value}", ctx.id, wheel.segment.key()));
    let mut row = row
        .id(id)
        .relative()
        .items_center()
        .justify_center()
        .w_full()
        .rounded(ds.len(Length::RadiusControl))
        .cursor_pointer()
        .on_click(move |_, window, cx| pick(value, true, window, cx));
    row = if chosen {
        row.bg(ds.color(Color::SelectionStrong))
            .text_color(ds.color(Color::TextPrimary))
            .font_weight(FontWeight(ds.number(Number::FontWeightSemibold)))
    } else {
        let hover = ds.color(Color::Selection);
        let primary = ds.color(Color::TextPrimary);
        row.text_color(ds.color(Color::TextSecondary))
            .hover_style(move |style| style.bg(hover).text_color(primary))
    };
    if ring {
        // An inset ring: the wheel clips, so an outside ring would be cut.
        row = row.child(
            div()
                .absolute()
                .inset_0()
                .rounded(ds.len(Length::RadiusControl))
                .border(ds.len(Length::FocusRingWidth))
                .border_color(ds.color(Color::ColorActionPrimary)),
        );
    }
    row.child(option.label.clone()).into_any_element()
}

/// ArrowUp/Down/Home/End pick, ArrowLeft/Right change column, Enter and Space finish.
fn key_handler(
    wheel: &Wheel,
    done: Done,
    pick: Pick,
) -> impl Fn(&gpui::KeyDownEvent, &mut Window, &mut App) + 'static {
    let options = wheel.options.clone();
    let index = wheel.index;
    let sides = wheel.sides.clone();
    move |event, window, cx| {
        let last = options.len().saturating_sub(1);
        let target = match event.keystroke.key.as_str() {
            "down" => Some((index + 1).min(last)),
            "up" => Some(index.saturating_sub(1)),
            "home" => Some(0),
            "end" => Some(last),
            "right" | "left" => {
                let side = if event.keystroke.key == "right" {
                    &sides.1
                } else {
                    &sides.0
                };
                if let Some(next) = side {
                    window.focus(next, cx);
                    cx.stop_propagation();
                }
                return;
            }
            "enter" | "space" => {
                done.run(window, cx);
                cx.stop_propagation();
                return;
            }
            _ => return,
        };
        if let Some(option) = target.and_then(|t| options.get(t)) {
            pick(option.value, false, window, cx);
        }
        cx.stop_propagation();
    }
}

/// A mouse-wheel or trackpad scroll picks the row it travels to (iOS-wheel behaviour): one row
/// per `row` pixels of travel.
fn wheel_handler(
    wheel: &Wheel,
    pick: Pick,
    row: gpui::Pixels,
) -> impl Fn(&gpui::ScrollWheelEvent, &mut Window, &mut App) + 'static {
    let options = wheel.options.clone();
    let index = wheel.index;
    let scrolled = wheel.scrolled.clone();
    move |event, window, cx| {
        let travel = f32::from(event.delta.pixel_delta(row).y);
        let height = f32::from(row).max(1.);
        let total = scrolled.update(cx, |sum, _| {
            *sum += travel;
            let rows = (*sum / height).trunc();
            *sum -= rows * height;
            rows
        });
        // Content moving down brings the previous value to the centre.
        #[expect(clippy::cast_possible_truncation, reason = "a few wheel rows")]
        let moved = -(total as i64);
        let last = i64::try_from(options.len().saturating_sub(1)).unwrap_or(0);
        let to = (i64::try_from(index).unwrap_or(0) + moved).clamp(0, last);
        if moved != 0
            && let Some(option) = usize::try_from(to).ok().and_then(|t| options.get(t))
        {
            pick(option.value, false, window, cx);
        }
        cx.stop_propagation();
    }
}
