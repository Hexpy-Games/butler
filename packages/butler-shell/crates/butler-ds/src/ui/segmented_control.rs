//! DS SegmentedControl (SegmentedControl.tsx / SegmentedControl.module.css): a flat track of
//! single-choice options, a hairline `--line` edge on `--surface` with the options inset by
//! `--space-1` and the chosen one filled with `--selection`. A `radiogroup` with a roving tab
//! stop: the arrows step through the enabled options (wrapping), Home and End jump to the ends,
//! and each move focuses and selects. `sm` insets the options by the focus ring's width and
//! draws its hairline inside that inset, so the ring stays whole inside the scrolling track.
use std::rc::Rc;

use gpui::{
    App, ElementId, FocusHandle, InteractiveElement as _, IntoElement, ParentElement as _,
    RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, px,
};

use super::Icon;
use super::context::Ds;
use super::control::{Blend, Control, Disabled, DisabledLook, Width};
use super::convert;
use super::focus;
use super::icon::{IconSize, icon};
use super::strut;
use crate::tokens::{Color, Length, Number};

type Handler = Rc<dyn Fn(&str, &mut Window, &mut App)>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Size {
    Sm,
    #[default]
    Default,
}

/// One choice: its value, label, an optional glyph that supports the label, and whether it is off.
#[derive(Clone)]
pub struct Choice {
    value: SharedString,
    label: SharedString,
    icon: Option<Icon>,
    disabled: bool,
}

impl Choice {
    pub fn new(value: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            value: value.into(),
            label: label.into(),
            icon: None,
            disabled: false,
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
}

#[derive(IntoElement)]
pub struct SegmentedControl {
    id: ElementId,
    aria_label: SharedString,
    options: Vec<Choice>,
    value: SharedString,
    size: Size,
    stretch: bool,
    on_change: Option<Handler>,
}

impl SegmentedControl {
    /// `aria_label` names the group (the accessible name; gpui draws none of it).
    pub fn new(
        id: impl Into<ElementId>,
        aria_label: impl Into<SharedString>,
        value: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            aria_label: aria_label.into(),
            options: Vec::new(),
            value: value.into(),
            size: Size::Default,
            stretch: false,
            on_change: None,
        }
    }

    pub fn options(mut self, options: impl IntoIterator<Item = Choice>) -> Self {
        self.options.extend(options);
        self
    }

    pub fn size(mut self, size: Size) -> Self {
        self.size = size;
        self
    }

    /// Fill the container's width, the options sharing it equally.
    pub fn stretch(mut self) -> Self {
        self.stretch = true;
        self
    }

    pub fn on_value_change(
        mut self,
        handler: impl Fn(&str, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }

    /// The accessible name of the group.
    pub fn aria_label(&self) -> &SharedString {
        &self.aria_label
    }
}

impl RenderOnce for SegmentedControl {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let shrink = strut::shrink_wrap(cx);
        let selected = self.options.iter().position(|o| o.value == self.value);
        let first_enabled = self.options.iter().position(|o| !o.disabled);
        let stop = selected.or(first_enabled).unwrap_or(0);
        let mut items = Vec::new();
        let mut handles = Vec::new();
        for (index, option) in self.options.iter().enumerate() {
            let id = ElementId::from(SharedString::from(format!("{}-{index}", self.id)));
            let focus = (!option.disabled).then(|| option_focus(&id, window, cx));
            if let Some(handle) = &focus {
                handles.push((index, handle.clone()));
            }
            let on = selected == Some(index);
            items.push(self.item(&id, option, (on, index == stop), focus, (window, cx)));
        }
        let ds = Ds::get(cx);
        let sm = self.size == Size::Sm;
        let inset = ds.len(if sm {
            Length::FocusRingWidth
        } else {
            Length::Space1
        });
        let radius = ds.len(Length::RadiusControl);
        let line = ds.color(Color::Line);
        let mut track = div()
            .id((self.id.clone(), "group"))
            .relative()
            .flex()
            .items_center()
            .min_w_0()
            .max_w_full()
            .gap(inset)
            .p(inset)
            .overflow_x_scroll()
            .rounded(radius)
            .bg(ds.color(Color::Surface));
        track = match (self.stretch, shrink) {
            (true, _) => track.w_full(),
            (false, true) => track.self_start(),
            (false, false) => track,
        };
        if sm {
            // `box-shadow: inset 0 0 0 1px var(--line)`.
            track = track.child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left_0()
                    .right_0()
                    .rounded(radius)
                    .border(ds.len(Length::BorderHairline))
                    .border_color(line),
            );
        } else {
            track = track
                .border(ds.len(Length::BorderHairline))
                .border_color(line);
        }
        let keys = self.on_change.clone().map(|handler| {
            let values: Vec<SharedString> = self.options.iter().map(|o| o.value.clone()).collect();
            move |event: &gpui::KeyDownEvent, window: &mut Window, cx: &mut App| {
                roving(
                    &event.keystroke.key,
                    &handles,
                    &values,
                    &handler,
                    window,
                    cx,
                );
            }
        });
        if let Some(keys) = keys {
            track = track.on_key_down(keys);
        }
        track.children(items)
    }
}

/// The focus handle of the option `id`, kept by the group (it moves focus between options).
fn option_focus(id: &ElementId, window: &mut Window, cx: &mut App) -> FocusHandle {
    window
        .use_keyed_state((id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
        .read(cx)
        .clone()
}

/// Arrow, Home and End keys: focus and select the target among the enabled options.
fn roving(
    key: &str,
    enabled: &[(usize, FocusHandle)],
    values: &[SharedString],
    on_change: &Handler,
    window: &mut Window,
    cx: &mut App,
) {
    let Some(here) = enabled.iter().position(|(_, h)| h.is_focused(window)) else {
        return;
    };
    let count = enabled.len();
    let target = match key {
        "right" | "down" => (here + 1) % count,
        "left" | "up" => (here + count - 1) % count,
        "home" => 0,
        "end" => count - 1,
        _ => return,
    };
    cx.stop_propagation();
    if let Some((index, handle)) = enabled.get(target) {
        window.focus(handle, cx);
        if let Some(value) = values.get(*index) {
            on_change(value, window, cx);
        }
    }
}

impl SegmentedControl {
    /// One option: `(on, tab stop)` say whether it is chosen and the group's roving stop.
    fn item(
        &self,
        id: &ElementId,
        option: &Choice,
        (on, tab_stop): (bool, bool),
        handle: Option<FocusHandle>,
        (window, cx): (&Window, &App),
    ) -> Control {
        let ds = Ds::get(cx);
        let focused = handle
            .as_ref()
            .is_some_and(|h| focus::visible(ds, h.is_focused(window), false));
        let sm = self.size == Size::Sm;
        let (secondary, primary) = (ds.color(Color::TextSecondary), ds.color(Color::TextPrimary));
        let selection = ds.color(Color::Selection);
        let mut control = Control::new(id.clone(), ds);
        control.radius = ds.len(Length::RadiusControl);
        control.padding = [
            ds.len(Length::SpaceSm),
            px(0.),
            ds.len(Length::SpaceSm),
            px(0.),
        ];
        control.gap = ds.len(Length::SpaceXs);
        control.scale = false;
        control.weight = ds.number(Number::FontWeightMedium);
        control.tab_stop = tab_stop;
        control.focus = handle;
        let (size, line, height) = if sm {
            (
                Length::FontSize1,
                Length::TypoCaptionLineHeight,
                Length::ControlHeightXs,
            )
        } else {
            (
                Length::FontSize2,
                Length::TypoLabelLineHeight,
                Length::ControlHeightMd,
            )
        };
        control.text_size = ds.len(size);
        control.line_height = Some(ds.len(line));
        // Mobile and touch: the default size grows to the hit target.
        control.min_height = Some(if ds.compact() && !sm {
            ds.len(Length::ControlHitTarget)
        } else {
            ds.len(height)
        });
        if self.stretch {
            control.width = Width::Grow;
        }
        if on || focused {
            control.fill = Blend::flat(selection);
            control.fg = Blend::flat(primary);
        } else {
            let hover = convert::with_alpha(selection, 0.72);
            control.fill = Blend::hover(gpui::transparent_black(), hover);
            control.fg = Blend::hover(secondary, primary);
        }
        control.disabled = if option.disabled {
            Disabled::Native
        } else {
            Disabled::No
        };
        control.disabled_look = DisabledLook::Opacity(0.52); // DS: SegmentedControl.module.css:92
        control.not_allowed = true;
        control.children = option_content(option, ds);
        if let Some(handler) = self.on_change.clone().filter(|_| !on) {
            let value = option.value.clone();
            control.on_click(Some(Rc::new(move |_: &gpui::ClickEvent, window, cx| {
                handler(&value, window, cx);
            })));
        }
        control
    }
}

fn option_content(option: &Choice, ds: &Ds) -> Vec<gpui::AnyElement> {
    let mut out = Vec::new();
    if let Some(glyph) = option.icon {
        out.push(icon(glyph, IconSize::Md, ds).into_any_element());
    }
    out.push(
        div()
            .whitespace_nowrap()
            .child(option.label.clone())
            .into_any_element(),
    );
    out
}
