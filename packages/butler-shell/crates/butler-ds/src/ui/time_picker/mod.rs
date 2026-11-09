//! DS TimePicker (TimePicker.tsx / TimePicker.module.css): a segmented time field (one part per
//! hour, minute and, in 12-hour, day period; digits and arrows type into it) in the Input look,
//! and a clock button that opens a Popover of wheel columns for pointer and touch. The value is
//! "HH:MM" (24 h); the language sets the segment order and the day-period words.
mod columns;
mod field;
mod model;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement as _, RenderOnce, SharedString,
    Styled as _, Window, div,
};

pub use model::HourCycle;

use self::columns::{Done, column_handle, columns};
use self::field::{pending_state, segment_handle, segments};
use self::model::{Layout, Parts, Segment, format, parse};
use crate::tokens::{Color, Duration as DsDuration, Easing, Length};
use crate::ui::Icon;
use crate::ui::context::{Ds, Lang};
use crate::ui::icon_button::IconButton;
use crate::ui::motion::{Props, Timing, Transition, transition};
use crate::ui::overlay::place::Align;
use crate::ui::popover::{Popover, PopoverContent, Width};
use crate::ui::{convert, focus};

type Handler = Rc<dyn Fn(SharedString, &mut Window, &mut App)>;
type Setter = Rc<dyn Fn(Parts, &mut Window, &mut App)>;

/// A child state id: `(id, a, b)`.
pub(super) fn sub(id: &ElementId, a: &'static str, b: &'static str) -> ElementId {
    ElementId::from((ElementId::from((id.clone(), a)), b))
}

/// What the field and the wheels share.
#[derive(Clone)]
struct Ctx {
    id: ElementId,
    cycle: HourCycle,
    layout: Layout,
    parts: Parts,
    /// Sets the value; the caller hears it only when the text changes.
    set: Setter,
    popover: Popover,
}

#[derive(IntoElement)]
pub struct TimePicker {
    id: ElementId,
    value: SharedString,
    picker_label: SharedString,
    lang: Option<Lang>,
    cycle: HourCycle,
    minute_step: u8,
    disabled: bool,
    default_open: bool,
    on_change: Option<Handler>,
}

impl TimePicker {
    /// `value` is "HH:MM", 24-hour; `picker_label` names the clock button ("Choose time").
    pub fn new(
        id: impl Into<ElementId>,
        value: impl Into<SharedString>,
        picker_label: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            value: value.into(),
            picker_label: picker_label.into(),
            lang: None,
            cycle: HourCycle::H12,
            minute_step: 5,
            disabled: false,
            default_open: false,
            on_change: None,
        }
    }

    /// Sets the segment order and the day-period words. Default: the DS language.
    pub fn locale(mut self, lang: Lang) -> Self {
        self.lang = Some(lang);
        self
    }

    /// 12-hour (the default, as ko and en-US) or 24-hour.
    pub fn hour_cycle(mut self, cycle: HourCycle) -> Self {
        self.cycle = cycle;
        self
    }

    /// The minute column's step in the popover (typed minutes stay free). Default 5.
    pub fn minute_step(mut self, step: u8) -> Self {
        self.minute_step = step;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Documentation: starts with the popover open.
    pub fn default_open(mut self) -> Self {
        self.default_open = true;
        self
    }

    /// Fires only when the value changes, with "HH:MM".
    pub fn on_value_change(
        mut self,
        handler: impl Fn(SharedString, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

/// How far the open or focused treatment has come, 0 to 1 (border colour over `--motion-fast`).
fn progress(
    id: &ElementId,
    active: bool,
    window: &mut Window,
    cx: &mut App,
) -> (Transition, Timing) {
    let ds = Ds::get(cx);
    let timing = Timing::token(ds, DsDuration::MotionFast, Easing::MotionEaseStandard);
    let value = transition(
        sub(id, "border", "motion"),
        (f32::from(active), ds.reduced_motion()),
        &timing,
        window,
        cx,
    );
    (value, timing)
}

impl TimePicker {
    /// Focus goes back to the hour segment when the wheels close by key or by Enter, Space or a
    /// tapped minute; a tap elsewhere leaves it where it went.
    fn popover(
        &self,
        hour: &gpui::FocusHandle,
        returning: &gpui::Entity<bool>,
        window: &mut Window,
        cx: &mut App,
    ) -> Popover {
        let (back, asked) = (hour.clone(), returning.clone());
        let popover = Popover::new(ElementId::from((self.id.clone(), "popover")), window, cx)
            .on_open_change(move |open, window, cx| {
                if open {
                    return;
                }
                let requested = asked.update(cx, |flag, _| std::mem::take(flag));
                if requested || Ds::get(cx).modality().focus_visible() {
                    window.focus(&back, cx);
                }
            });
        if self.default_open {
            let started =
                window.use_keyed_state(sub(&self.id, "started", "open"), cx, |_, _| false);
            if !*started.read(cx) {
                started.update(cx, |started, _| *started = true);
                popover.set_open(true, window, cx);
            }
        }
        popover
    }
}

impl RenderOnce for TimePicker {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let lang = self.lang.unwrap_or_else(|| Ds::get(cx).lang());
        let layout = Layout::of(lang, self.cycle);
        let handles: Rc<Vec<gpui::FocusHandle>> = Rc::new(
            layout
                .order
                .iter()
                .map(|segment| segment_handle(&self.id, *segment, window, cx))
                .collect(),
        );
        let hour = handles[layout.index(Segment::Hour).unwrap_or(0)].clone();
        let pending = pending_state(&self.id, window, cx);
        let returning = window.use_keyed_state(sub(&self.id, "return", "focus"), cx, |_, _| false);
        let popover = self.popover(&hour, &returning, window, cx);
        let open = popover.is_open(cx);
        let ctx = Ctx {
            id: self.id.clone(),
            cycle: self.cycle,
            layout,
            parts: parse(&self.value),
            set: self.setter(),
            popover: popover.clone(),
        };
        let content = self.content(&ctx, &returning, open, window, cx);
        let ring = handles
            .iter()
            .any(|h| focus::visible(Ds::get(cx), h.is_focused(window), false));
        let active = !self.disabled && (open || handles.iter().any(|h| h.is_focused(window)));
        let progress = progress(&self.id, active, window, cx);
        let trigger = popover.trigger(|toggle| {
            let button = IconButton::new(
                ElementId::from((self.id.clone(), "clock")),
                self.picker_label.clone(),
            )
            .glyph(Icon::Clock3)
            .menu_trigger()
            .on_click(toggle.on_click());
            let button = if self.disabled {
                button.disabled()
            } else {
                button
            };
            button.into_any_element()
        });
        let ds = Ds::get(cx);
        let field = field_box(ds, progress, ring, self.disabled)
            .child(segments(
                &ctx,
                &handles,
                &pending,
                self.disabled,
                window,
                ds,
            ))
            .child(trigger);
        div()
            .w_full()
            .min_w_0()
            .child(popover.anchor(field))
            .child(content)
    }
}

impl TimePicker {
    fn setter(&self) -> Setter {
        let (value, on_change) = (self.value.clone(), self.on_change.clone());
        Rc::new(move |next, window, cx| {
            let text = format(next);
            if text != value.as_ref()
                && let Some(handler) = &on_change
            {
                handler(text.into(), window, cx);
            }
        })
    }

    /// The popover surface; on open, focus moves to the hour wheel.
    fn content(
        &self,
        ctx: &Ctx,
        returning: &gpui::Entity<bool>,
        open: bool,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let entered = window.use_keyed_state(sub(&self.id, "entered", "wheels"), cx, |_, _| false);
        if open != *entered.read(cx) {
            entered.update(cx, |entered, _| *entered = open);
            if open {
                let wheel = column_handle(&self.id, Segment::Hour, window, cx);
                window.defer(cx, move |window, cx| window.focus(&wheel, cx));
            }
        }
        let done = Done {
            returning: returning.clone(),
            ctx: ctx.clone(),
        };
        let body = columns(ctx, i32::from(self.minute_step), &done, window, cx);
        ctx.popover.content(
            PopoverContent::new()
                .align(Align::Start)
                .width(Width::Anchor)
                .child(body),
            window,
            cx,
        )
    }
}

/// `.field`: the Input look (height, line, radius, raised fill), the accent border while open or
/// focused, and the ring on keyboard focus. Phones and coarse pointers keep the hit target.
fn field_box(
    ds: &Ds,
    (progress, timing): (Transition, Timing),
    ring: bool,
    disabled: bool,
) -> gpui::Div {
    let line = ds.color(Color::Line);
    let focused = convert::mix(ds.color(Color::Accent), line, 0.52); // DS: TimePicker.module.css:26
    let (fill, text) = if disabled {
        (
            ds.color(Color::ColorDisabledBg),
            ds.color(Color::InteractiveDisabledFg),
        )
    } else {
        (
            convert::with_alpha(ds.color(Color::SurfaceRaised), 0.92), // DS: TimePicker.module.css:17
            ds.color(Color::TextPrimary),
        )
    };
    let border = progress.apply(
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .rounded(ds.len(Length::RadiusControl))
            .border(ds.len(Length::BorderHairline))
            .border_color(focused),
        &timing,
        &Props {
            opacity: Some((0., 1.)),
            ..Default::default()
        },
    );
    let mut field = div()
        .relative()
        .flex()
        .items_center()
        .justify_between()
        .gap(ds.len(Length::SpaceXs))
        .w_full()
        .min_w_0()
        .pl(ds.len(Length::SpaceSm))
        .pr(ds.len(Length::SpaceXs))
        .border(ds.len(Length::BorderHairline))
        .border_color(line)
        .rounded(ds.len(Length::RadiusControl))
        .bg(fill)
        .text_color(text)
        .font_family(ds.body_font().clone())
        .text_size(ds.len(Length::TypoBodySize))
        .line_height(ds.len(Length::TypoBodyLineHeight))
        .child(border);
    field = if ds.compact() {
        field.min_h(ds.len(Length::ControlHitTarget))
    } else {
        field.h(ds.len(Length::ControlHeightLg))
    };
    if disabled {
        field = field.cursor_not_allowed();
    }
    if ring {
        field = field.shadow(focus::shadows(ds));
    }
    field
}
