//! DS Switch (shadcn/ui/switch.tsx / Switch.module.css): a 34x20 track (24x14 small) with a
//! round thumb that springs across over `--motion-base` on `--motion-ease-spring` (no motion
//! under reduced motion; the track colour never fades). A blocked switch with a
//! `disabledReason` stays focusable and hoverable (`aria-disabled`) and names the reason in a
//! Tooltip on its right; a plain `disabled` one is not focusable.
use std::rc::Rc;

use gpui::{
    App, ClickEvent, ElementId, InteractiveElement as _, IntoElement, ParentElement as _,
    RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, px,
};

use super::context::Ds;
use super::control::{Blend, Control, Disabled, DisabledLook, Width};
use super::convert;
use super::motion::{Props, Timing, Transition, transition};
use super::tooltip::{Align, Side, Tooltip};
use crate::tokens::{Color, Duration as DsDuration, Easing, Length, Shadow};

type Handler = Rc<dyn Fn(bool, &mut Window, &mut App)>;
type Toggle = Rc<dyn Fn(&mut Window, &mut App)>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Size {
    #[default]
    Default,
    Sm,
}

/// Track and thumb geometry of a size.
struct Geometry {
    width: f32,
    height: f32,
    padding: f32,
    thumb: f32,
    travel: f32,
}

impl Size {
    fn geometry(self) -> Geometry {
        match self {
            // DS: Switch.module.css:2-5, 24-26, 39-41
            Self::Default => Geometry {
                width: 34.,
                height: 20.,
                padding: 2.,
                thumb: 16.,
                travel: 14.,
            },
            // DS: Switch.module.css:13-17, 49-55
            Self::Sm => Geometry {
                width: 24.,
                height: 14.,
                padding: 1.,
                thumb: 12.,
                travel: 10.,
            },
        }
    }
}

#[derive(IntoElement)]
pub struct Switch {
    id: ElementId,
    size: Size,
    checked: Option<bool>,
    default_checked: bool,
    disabled: bool,
    reason: Option<SharedString>,
    reason_side: Side,
    reason_align: Align,
    on_change: Option<Handler>,
}

impl Switch {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            size: Size::Default,
            checked: None,
            default_checked: false,
            disabled: false,
            reason: None,
            reason_side: Side::Right,
            reason_align: Align::Center,
            on_change: None,
        }
    }

    pub fn size(mut self, size: Size) -> Self {
        self.size = size;
        self
    }

    /// Controlled: the caller keeps the value and applies `on_checked_change`.
    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = Some(checked);
        self
    }

    /// Uncontrolled: the switch keeps its own value, starting here.
    pub fn default_checked(mut self, checked: bool) -> Self {
        self.default_checked = checked;
        self
    }

    /// `disabled`: not focusable, no activation.
    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    /// Blocks the switch and names why in a tooltip; it wins over `disabled`.
    pub fn disabled_reason(mut self, reason: impl Into<SharedString>) -> Self {
        self.reason = Some(reason.into());
        self
    }

    pub fn disabled_reason_side(mut self, side: Side) -> Self {
        self.reason_side = side;
        self
    }

    pub fn disabled_reason_align(mut self, align: Align) -> Self {
        self.reason_align = align;
        self
    }

    pub fn on_checked_change(
        mut self,
        handler: impl Fn(bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Switch {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let own = window.use_keyed_state((self.id.clone(), "checked"), cx, {
            let initial = self.default_checked;
            move |_, _| initial
        });
        let checked = self.checked.unwrap_or_else(|| *own.read(cx));
        let (t, timing) = self.thumb_position(checked, window, cx);
        let blocked = self.reason.is_some();
        let ds = Ds::get(cx);
        let geometry = self.size.geometry();
        let mut control = Control::new(self.id.clone(), ds);
        control.width = Width::Fixed(geometry.width);
        control.height = Some(px(geometry.height));
        control.padding = [px(geometry.padding); 4];
        control.radius = ds.len(Length::RadiusPill);
        control.justify_center = false;
        control.scale = false;
        control.fill = Blend::flat(ds.color(if checked {
            Color::Accent
        } else {
            Color::SwitchTrackBg
        }));
        control.disabled = match (blocked, self.disabled) {
            (true, _) => Disabled::Aria,
            (false, true) => Disabled::Native,
            _ => Disabled::No,
        };
        control.disabled_look = DisabledLook::Opacity(0.5); // DS: Switch.module.css:31
        control.not_allowed = true;
        control.children = vec![thumb(ds, &geometry, t, &timing)];
        let toggle = toggle(own, checked, self.checked.is_some(), self.on_change.clone());
        // Touch and phone: an invisible box grows the hit area to `--control-hit-target`.
        let live = !control.disabled.is_on();
        let hit = f32::from(ds.len(Length::ControlHitTarget));
        let slop = ((hit - geometry.width) / 2., (hit - geometry.height) / 2.);
        if live && ds.compact() && slop.1 > 0. {
            control
                .overlay
                .push(hit_area(&self.id, slop, toggle.clone()));
        }
        control.on_click(Some(Rc::new(move |_: &ClickEvent, window, cx| {
            toggle(window, cx);
        })));
        match self.reason {
            Some(reason) => Tooltip::new((self.id, "reason"))
                .label(reason)
                .side(self.reason_side)
                .align(self.reason_align)
                .child(control)
                .into_any_element(),
            None => control.into_any_element(),
        }
    }
}

impl Switch {
    /// The thumb's place along its travel, 0 to 1: it glides over `--motion-base` on the spring
    /// curve toward the value, and sits at once under reduced motion.
    fn thumb_position(
        &self,
        checked: bool,
        window: &mut Window,
        cx: &mut App,
    ) -> (Transition, Timing) {
        let ds = Ds::get(cx);
        let mut timing = Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseSpring);
        if ds.reduced_motion() {
            timing.duration = std::time::Duration::ZERO;
        }
        let value = transition(
            (self.id.clone(), "thumb"),
            (f32::from(checked), ds.reduced_motion()),
            &timing,
            window,
            cx,
        );
        (value, timing)
    }
}

fn thumb(ds: &Ds, geometry: &Geometry, t: Transition, timing: &Timing) -> gpui::AnyElement {
    t.apply(
        div()
            .flex_none()
            .size(px(geometry.thumb))
            .ml(px(geometry.travel * t.target()))
            .rounded_full()
            .bg(ds.color(Color::SwitchThumb))
            .shadow(convert::box_shadows(
                ds.tokens().shadow(Shadow::ShadowControl),
                ds.tokens(),
            )),
        timing,
        &Props {
            offset: Some((
                gpui::point(px(-geometry.travel * t.target()), px(0.)),
                gpui::point(px(geometry.travel * (1. - t.target())), px(0.)),
            )),
            ..Default::default()
        },
    )
    .into_any_element()
}

/// The toggle action: flips the own value when uncontrolled and reports the new one.
fn toggle(
    own: gpui::Entity<bool>,
    checked: bool,
    controlled: bool,
    on_change: Option<Handler>,
) -> Toggle {
    Rc::new(move |window, cx| {
        let next = !checked;
        if !controlled {
            own.update(cx, |value, cx| {
                *value = next;
                cx.notify();
            });
        }
        if let Some(handler) = &on_change {
            handler(next, window, cx);
        }
    })
}

/// The `::after` box that grows the hit target to `--control-hit-target` (`slop` per axis).
fn hit_area(id: &ElementId, (x, y): (f32, f32), toggle: Toggle) -> gpui::AnyElement {
    div()
        .id((id.clone(), "hit"))
        .absolute()
        .top(px(-y))
        .bottom(px(-y))
        .left(px(-x.max(0.)))
        .right(px(-x.max(0.)))
        .on_click(move |_, window, cx| {
            cx.stop_propagation();
            toggle(window, cx);
        })
        .into_any_element()
}
