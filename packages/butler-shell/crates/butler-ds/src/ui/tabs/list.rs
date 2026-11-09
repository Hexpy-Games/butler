//! The tab list and its triggers (Tabs.module.css `.list`, `.trigger`). The list scrolls on x
//! with the shared edge fade; the line variant keeps `--focus-ring-room` around its triggers and
//! bleeds the same amount back out so the tabs stay where they were.
use gpui::{
    AnyElement, App, ElementId, FocusHandle, IntoElement, ParentElement as _, SharedString,
    Styled as _, Window, div, px, relative,
};

use super::indicator::{Measure, Shared, Slide};
use crate::tokens::{Color, Length, Number};
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::control::{Blend, Control, Disabled, DisabledLook, Width};
use crate::ui::icon::{IconSize, icon};
use crate::ui::scroll::{self, Axis};
use crate::ui::{convert, focus, strut};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ListVariant {
    /// A bordered track on `--surface` with the active tab filled.
    #[default]
    Default,
    /// Bare tabs with a sliding underline.
    Line,
}

/// One tab: its value, label, an optional glyph, and whether it is off.
#[derive(Clone)]
pub struct Trigger {
    pub(super) value: SharedString,
    label: SharedString,
    icon: Option<Icon>,
    pub(super) disabled: bool,
    anchor: Option<SharedString>,
}

impl Trigger {
    pub fn new(value: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            value: value.into(),
            label: label.into(),
            icon: None,
            disabled: false,
            anchor: None,
        }
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    /// Names the trigger for the live harness (`debug_selector`).
    pub fn anchor(mut self, name: impl Into<SharedString>) -> Self {
        self.anchor = Some(name.into());
        self
    }
}

/// The list: its variant, whether it fills the width (equal columns) and its triggers.
pub struct TabsList {
    pub(super) aria_label: SharedString,
    pub(super) variant: ListVariant,
    pub(super) stretch: bool,
    pub(super) triggers: Vec<Trigger>,
}

impl TabsList {
    /// `aria_label` names the list (the accessible name; gpui draws none of it).
    pub fn new(aria_label: impl Into<SharedString>) -> Self {
        Self {
            aria_label: aria_label.into(),
            variant: ListVariant::Default,
            stretch: false,
            triggers: Vec::new(),
        }
    }

    pub fn variant(mut self, variant: ListVariant) -> Self {
        self.variant = variant;
        self
    }

    pub fn stretch(mut self) -> Self {
        self.stretch = true;
        self
    }

    pub fn triggers(mut self, triggers: impl IntoIterator<Item = Trigger>) -> Self {
        self.triggers.extend(triggers);
        self
    }
}

/// What a list renders with.
pub(super) struct Context<'a> {
    pub(super) id: &'a ElementId,
    pub(super) vertical: bool,
    pub(super) active: Option<usize>,
    /// Focus handles of the triggers (`None`: disabled).
    pub(super) handles: &'a [Option<FocusHandle>],
    /// The trigger that is the list's tab stop.
    pub(super) stop: usize,
}

impl TabsList {
    /// One trigger as a control.
    fn trigger(
        &self,
        index: usize,
        ctx: &Context,
        ready: bool,
        shared: &Shared,
        window: &Window,
        cx: &App,
    ) -> Control {
        let ds = Ds::get(cx);
        let trigger = &self.triggers[index];
        let line = self.variant == ListVariant::Line;
        let on = ctx.active == Some(index);
        let handle = ctx.handles.get(index).cloned().flatten();
        let ring = handle
            .as_ref()
            .is_some_and(|h| focus::visible(ds, h.is_focused(window), false));
        let id = ElementId::from(SharedString::from(format!("{}-trigger-{index}", ctx.id)));
        let mut control = Control::new(id, ds);
        control.debug.clone_from(&trigger.anchor);
        control.radius = ds.len(Length::RadiusControl);
        control.scale = false;
        control.weight = ds.number(Number::FontWeightMedium);
        control.text_size = ds.len(Length::FontSize2);
        control.line_height = Some(ds.len(Length::TypoLabelLineHeight));
        control.min_height = Some(if ds.compact() {
            ds.len(Length::ControlHitTarget)
        } else {
            px(30.) // DS: Tabs.module.css:119
        });
        control.tab_stop = index == ctx.stop;
        control.focus = handle;
        let (inline, gap) = if self.stretch {
            (Length::SpaceSm, Length::SpaceXs)
        } else {
            (Length::Space3, Length::Space2)
        };
        control.gap = ds.len(gap);
        let (top, bottom) = if line {
            (
                ds.len(Length::SpaceXs),
                ds.len(Length::TabsLineIndicatorGap),
            )
        } else {
            (px(0.), px(0.))
        };
        control.padding = [ds.len(inline), top, ds.len(inline), bottom];
        control.justify_center = !ctx.vertical;
        if self.stretch {
            control.width = Width::Grow;
        }
        colours(&mut control, ds, line, on || ring);
        if line && !ring {
            control.radius = px(0.);
            if on && !ready {
                control.overlay.push(underline(ds));
            }
        }
        control.disabled = if trigger.disabled {
            Disabled::Native
        } else {
            Disabled::No
        };
        control.disabled_look = DisabledLook::Opacity(0.52); // DS: Tabs.module.css:185
        control.not_allowed = true;
        let mut children: Vec<AnyElement> = Vec::new();
        if let Some(glyph) = trigger.icon {
            children.push(icon(glyph, IconSize::Md, ds).into_any_element());
        }
        children.push(
            div()
                .whitespace_nowrap()
                .child(trigger.label.clone())
                .into_any_element(),
        );
        children.push(Measure::probe(shared, Some(index)).into_any_element());
        control.children = children;
        control
    }

    /// The list: a scroller with the edge fade (horizontal), or a plain column (vertical).
    pub(super) fn render(&self, ctx: &Context, window: &mut Window, cx: &mut App) -> AnyElement {
        let slide = window.use_keyed_state((ctx.id.clone(), "slide"), cx, |_, _| Slide::new());
        let shared = slide.read(cx).measure.clone();
        let ready = slide.read(cx).ready();
        let triggers: Vec<AnyElement> = (0..self.triggers.len())
            .map(|i| {
                strut::flex_scope(false, self.trigger(i, ctx, ready, &shared, window, cx))
                    .into_any_element()
            })
            .collect();
        let line = self.variant == ListVariant::Line;
        let (bar, moving) = if line && !ctx.vertical {
            slide.update(cx, |s, cx| s.place(ctx.active, window, cx))
        } else {
            (None, false)
        };
        if moving {
            window.request_animation_frame();
        }
        let ds = Ds::get(cx);
        let room = focus::room(ds);
        let shrink = strut::shrink_wrap(cx);
        let space1 = ds.len(Length::Space1);
        let mut content = div()
            .relative()
            .flex()
            .gap(space1)
            .child(Measure::probe(&shared, None));
        content = if ctx.vertical {
            content.flex_col().items_stretch()
        } else {
            content
                .flex_row()
                .items_center()
                .flex_none()
                .min_w(relative(1.))
        };
        content = if line {
            content.p(room)
        } else {
            content.p(space1)
        };
        let content = content.children(triggers).children(bar);
        let mut list = div().flex().flex_row().min_w_0();
        list = if line {
            list.m(-room).min_h(px(30.) + room * 2.) // DS: Tabs.module.css:76
        } else {
            list.min_h(px(32.)) // DS: Tabs.module.css:60
                .border(ds.len(Length::BorderHairline))
                .border_color(ds.color(Color::Line))
                .rounded(ds.len(Length::RadiusControl))
                .bg(ds.color(Color::Surface))
        };
        list = match (self.stretch, line, shrink) {
            (true, false, _) => list.w_full(),
            (false, false, true) => list.self_start().max_w_full(),
            _ => list,
        };
        if ctx.vertical {
            return list.child(content).into_any_element();
        }
        let config = scroll::Config {
            id: ElementId::from(SharedString::from(format!("{}-list", ctx.id))),
            axis: Axis::X,
            size: ds.len(Length::ScrollFadeSize),
            guard: px(0.),
        };
        scroll::scroller(&config, list.child(content), window, cx).element
    }
}

/// Text and fill: the active (or ring-focused) tab is lit; the others warm on hover. The line
/// variant never fills.
fn colours(control: &mut Control, ds: &Ds, line: bool, lit: bool) {
    let (secondary, primary) = (ds.color(Color::TextSecondary), ds.color(Color::TextPrimary));
    let selection = ds.color(Color::Selection);
    control.fg = if lit {
        Blend::flat(primary)
    } else {
        Blend::hover(secondary, primary)
    };
    control.fill = match (line, lit) {
        (true, _) => Blend::flat(gpui::transparent_black()),
        (false, true) => Blend::flat(selection),
        (false, false) => Blend::hover(
            gpui::transparent_black(),
            convert::with_alpha(selection, 0.72),
        ),
    };
}

/// `box-shadow: inset 0 -2px 0 var(--accent)`.
fn underline(ds: &Ds) -> AnyElement {
    div()
        .absolute()
        .left_0()
        .right_0()
        .bottom_0()
        .h(ds.len(Length::BorderWidthStrong))
        .bg(ds.color(Color::Accent))
        .into_any_element()
}
