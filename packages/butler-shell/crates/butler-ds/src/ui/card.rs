//! DS Card (Card.tsx / Card.module.css): a bordered raised surface; interactive cards hover,
//! select and take the focus ring; a running card pulses a ring in the worker colour.
use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, ClickEvent, Corners, ElementId, InteractiveElement as _, IntoElement,
    ParentElement, Pixels, RenderOnce, StatefulInteractiveElement as _, Styled as _, Window,
    canvas, div, px,
};

use super::context::Ds;
use super::convert;
use super::focus;
use super::layout::{ItemProps, WithItem};
use super::motion::{Loop, Timing, Tween};
use crate::tokens::{Color, Duration as DsDuration, Easing, Length};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CardPadding {
    None,
    Sm,
    #[default]
    Md,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CardRadius {
    #[default]
    Control,
    Lg,
}

/// `color-mix(in srgb, var(--accent) 7%, var(--surface-raised))` of a selected card.
const SELECTED_SHARE: f32 = 0.07; // DS: Card.module.css:50
/// The running ring: `0 0 0 3px color-mix(in srgb, var(--worker-active) 32%, transparent)`.
const RING_WIDTH: f32 = 3.; // DS: Card.module.css:34
const RING_SHARE: f32 = 0.32; // DS: Card.module.css:34
/// The ring sits on the border box (`inset: -1px`).
const RING_INSET: f32 = 1.; // DS: Card.module.css:30
/// The pulse's resting and low opacity (`0%, 100%` and `50%` of the keyframes).
const PULSE_HIGH: f32 = 0.6; // DS: Card.module.css:37
const PULSE_LOW: f32 = 0.15; // DS: Card.module.css:44

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Card {
    id: ElementId,
    padding: CardPadding,
    radius: CardRadius,
    interactive: bool,
    selected: bool,
    running: bool,
    on_click: Option<ClickHandler>,
    item: ItemProps,
    children: Vec<AnyElement>,
}

impl Card {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            padding: CardPadding::Md,
            radius: CardRadius::Control,
            interactive: false,
            selected: false,
            running: false,
            on_click: None,
            item: ItemProps::default(),
            children: Vec::new(),
        }
    }

    pub fn padding(mut self, padding: CardPadding) -> Self {
        self.padding = padding;
        self
    }

    pub fn radius(mut self, radius: CardRadius) -> Self {
        self.radius = radius;
        self
    }

    pub fn interactive(mut self) -> Self {
        self.interactive = true;
        self
    }

    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    /// `activity="running"`.
    pub fn running(mut self) -> Self {
        self.running = true;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl WithItem for Card {
    fn item_mut(&mut self) -> &mut ItemProps {
        &mut self.item
    }
}

impl ParentElement for Card {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// The ring of a running card at pulse progress `t` (one loop, 0 to 1): opacity 0.6, 0.15, 0.6
/// with the standard easing on each half.
fn pulse(ease: impl Fn(f32) -> f32, t: f32) -> f32 {
    let (from, to, local) = if t < 0.5 {
        (PULSE_HIGH, PULSE_LOW, t * 2.)
    } else {
        (PULSE_LOW, PULSE_HIGH, t * 2. - 1.)
    };
    from + (to - from) * ease(local)
}

fn ring(color: gpui::Hsla, radius: Pixels, opacity: f32) -> gpui::Div {
    let shadow = gpui::BoxShadow {
        color: convert::with_alpha(color, opacity).into(),
        offset: gpui::point(px(0.), px(0.)),
        blur_radius: px(0.),
        spread_radius: px(RING_WIDTH),
        inset: false,
    };
    let paint = move |bounds: Bounds<Pixels>, (): (), window: &mut Window, _: &mut App| {
        window.paint_drop_shadows_outside(
            bounds,
            Corners::all(radius),
            0.,
            std::slice::from_ref(&shadow),
        );
    };
    div()
        .absolute()
        .top(px(-RING_INSET))
        .left(px(-RING_INSET))
        .right(px(-RING_INSET))
        .bottom(px(-RING_INSET))
        .child(
            canvas(|_, _, _| (), paint)
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
        )
}

impl RenderOnce for Card {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let focus_handle = self.interactive.then(|| {
            window.use_keyed_state((self.id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
        });
        let ds = Ds::get(cx);
        let radius = ds.len(match self.radius {
            CardRadius::Control => Length::RadiusControl,
            CardRadius::Lg => Length::RadiusPopover,
        });
        let padding = match self.padding {
            CardPadding::None => px(0.),
            CardPadding::Sm => ds.len(Length::Space2),
            CardPadding::Md => ds.len(Length::Space3),
        };
        let raised = ds.color(Color::SurfaceRaised);
        let (mut border, mut bg) = (ds.color(Color::Line), raised);
        if self.running {
            border = ds.color(Color::WorkerActive);
        }
        if self.selected {
            border = ds.color(Color::Accent);
            bg = convert::mix(border, raised, SELECTED_SHARE);
        }
        let mut el = div()
            .id(self.id.clone())
            .relative()
            .w_full()
            .min_w_0()
            .p(padding)
            .border(px(1.)) // DS: Card.module.css:2
            .border_color(border)
            .rounded(radius)
            .bg(bg)
            .text_color(ds.color(Color::TextPrimary));
        if self.interactive {
            let hover = ds.color(Color::Selection);
            el = el
                .cursor_pointer()
                .hover_style(move |style| style.bg(hover));
        }
        if let (Some(focus_handle), true) = (focus_handle, self.interactive) {
            let handle = focus_handle.read(cx).clone();
            let ds = Ds::get(cx);
            el = el.track_focus(&handle).tab_stop(true);
            if focus::visible(ds, handle.is_focused(window), false) {
                el = el.shadow(focus::shadows(ds));
            }
        }
        if let (true, Some(handler)) = (self.interactive, self.on_click.clone()) {
            el = el.on_click(move |event, window, cx| handler(event, window, cx));
        }
        let ds = Ds::get(cx);
        let ring = self.running.then(|| self.running_ring(ds, radius));
        self.item
            .apply(el, ds)
            .children(self.children)
            .children(ring)
    }
}

impl Card {
    /// The ring of a running card, pulsing every `--pulse-duration` (static under reduced motion).
    fn running_ring(&self, ds: &Ds, radius: Pixels) -> AnyElement {
        let color = convert::with_alpha(ds.color(Color::WorkerActive), RING_SHARE);
        if !Loop::Decorative.runs(ds) {
            return ring(color, radius, PULSE_HIGH).into_any_element();
        }
        let timing = Timing::linear(ds.duration(DsDuration::PulseDuration));
        let ease = convert::easing(ds.tokens().ease(Easing::MotionEaseStandard));
        Tween::new((self.id.clone(), "pulse"), div(), timing, move |_, t| {
            ring(color, radius, pulse(&ease, t))
        })
        .repeat()
        .into_any_element()
    }
}
