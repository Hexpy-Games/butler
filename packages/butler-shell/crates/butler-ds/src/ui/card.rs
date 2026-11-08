//! DS Card (Card.tsx / Card.module.css): a bordered raised surface; interactive cards hover,
//! select and take the focus ring; a running card pulses a ring in the worker colour.
use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, ClickEvent, Corners, ElementId, InteractiveElement as _, IntoElement,
    LayerMotion, MotionRepeat, ParentElement, Pixels, RenderOnce, StatefulInteractiveElement as _,
    Styled as _, Window, canvas, div, px,
};

use super::context::Ds;
use super::convert;
use super::focus;
use super::layout::{ItemProps, WithItem};
use super::motion::{Loop, Props, Timing, looping, mounted_at};
use super::strut;
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
            let handle = focus::tab_stop(focus_handle.read(cx), true);
            let ds = Ds::get(cx);
            el = el.track_focus(&handle);
            if focus::visible(ds, handle.is_focused(window), false) {
                el = el.shadow(focus::shadows(ds));
            }
        }
        if let (true, Some(handler)) = (self.interactive, self.on_click.clone()) {
            el = el.on_click(move |event, window, cx| handler(event, window, cx));
        }
        let ring = self.running.then(|| self.running_ring(radius, window, cx));
        let ds = Ds::get(cx);
        strut::scope(
            true,
            strut::container(self.item.apply(el, ds), ds)
                .children(self.children)
                .children(ring),
        )
    }
}

impl Card {
    /// The ring of a running card, pulsing every `--pulse-duration` (static under reduced motion).
    fn running_ring(&self, radius: Pixels, window: &mut Window, cx: &mut App) -> AnyElement {
        let ds = Ds::get(cx);
        let color = convert::with_alpha(ds.color(Color::WorkerActive), RING_SHARE);
        if !Loop::Decorative.runs(ds) {
            return ring(color, radius, PULSE_HIGH).into_any_element();
        }
        let mut timing = Timing::token(ds, DsDuration::PulseDuration, Easing::MotionEaseStandard);
        let cycle = Timing::linear(timing.duration);
        timing.duration /= 2;
        let start = mounted_at((self.id.clone(), "pulse"), window, cx);
        // Source-over at weight one must reach HIGH over LOW exactly.
        let overlay_alpha =
            (color.alpha * (PULSE_HIGH - PULSE_LOW)) / (1. - color.alpha * PULSE_LOW);
        let halves = [((0., 0.5), (1., 0.)), ((0.5, 1.), (0., 1.))];
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .child(ring(color, radius, PULSE_LOW))
            .children(halves.map(|(visible, opacity)| {
                let pulse = looping(
                    ring(
                        gpui::Hsla {
                            alpha: overlay_alpha,
                            ..color
                        },
                        radius,
                        1.,
                    ),
                    &timing,
                    start,
                    false,
                    &Props {
                        opacity: Some(opacity),
                        ..Default::default()
                    },
                );
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .motion(LayerMotion {
                        visible,
                        repeat: MotionRepeat::Loop,
                        ..cycle.motion(start)
                    })
                    .child(pulse)
            }))
            .into_any_element()
    }
}
