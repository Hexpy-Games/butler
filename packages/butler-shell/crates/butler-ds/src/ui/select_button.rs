//! DS SelectButton (shadcn/ui/select.tsx, Select.module.css `.trigger`): a plain button styled as
//! the Select trigger, for custom popovers such as a searchable list. The value stays left-aligned
//! before the chevron; chosen values show a count badge and the accent. Keyboard focus draws the
//! ring; any focus takes the accent border.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _, Window,
    div, px,
};

use super::Icon;
use super::context::Ds;
use super::control::{next_anchor, ring_layer};
use super::convert;
use super::focus;
use super::icon::{IconSize, icon};
use super::strut;
use crate::tokens::{Color, Length, Number};

/// `size`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Size {
    #[default]
    Default,
    Sm,
}

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct SelectButton {
    id: ElementId,
    size: Size,
    count: Option<usize>,
    placeholder: bool,
    disabled: bool,
    children: Vec<AnyElement>,
    text: Option<SharedString>,
    on_click: Option<Handler>,
}

impl SelectButton {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            size: Size::Default,
            count: None,
            placeholder: false,
            disabled: false,
            children: Vec::new(),
            text: None,
            on_click: None,
        }
    }

    pub fn size(mut self, size: Size) -> Self {
        self.size = size;
        self
    }

    /// How many values are chosen: an accent badge, and the button reads as active.
    pub fn count(mut self, count: usize) -> Self {
        self.count = Some(count);
        self
    }

    /// The text is a placeholder (`data-placeholder`): it reads in `--placeholder`.
    pub fn placeholder(mut self) -> Self {
        self.placeholder = true;
        self
    }

    /// `disabled`: not focusable and not pressed. Radix sets the attribute and the DS styles
    /// nothing more for it.
    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    pub fn text(mut self, text: impl Into<SharedString>) -> Self {
        self.text = Some(text.into());
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

impl ParentElement for SelectButton {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// `padding: 0 9px` (DS: Select.module.css:7).
const PADDING: f32 = 9.;

/// Where the value starts inside the trigger: its border and padding.
pub(crate) fn value_inset(ds: &Ds) -> f32 {
    let padding = if ds.compact() {
        ds.len(Length::SpaceMd)
    } else {
        px(PADDING)
    };
    f32::from(padding + ds.len(Length::BorderHairline))
}

impl RenderOnce for SelectButton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let handle = window
            .use_keyed_state((self.id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
            .read(cx)
            .clone();
        let anchor = next_anchor(cx, (!self.disabled).then_some(&handle));
        let focused = !self.disabled && handle.is_focused(window);
        let ds = Ds::get(cx);
        let ring = focused && focus::visible(ds, true, false) && !focus::ring_handed_off(cx);
        let active = self.count.is_some_and(|count| count > 0);
        let (radius, border, height) = geometry(self.size, active, focused, ds);
        let surface = surface(border, ds);
        let badge = self.count.filter(|_| active).map(|count| badge(count, ds));
        let value = div()
            .min_w_0()
            .overflow_hidden()
            .whitespace_nowrap()
            .text_ellipsis()
            .children(self.text)
            .children(self.children);
        let room = focus::room(ds);
        let mut root = div()
            .id(self.id.clone())
            .relative()
            .flex()
            .items_center()
            .justify_between()
            .w_full()
            .min_h(height)
            .pl(px(value_inset(ds)))
            .pr(px(value_inset(ds)))
            .gap(ds.len(Length::SpaceSm))
            .text_color(if active {
                ds.color(Color::AccentText)
            } else if self.placeholder {
                ds.color(Color::Placeholder)
            } else {
                ds.color(Color::TextPrimary)
            })
            .child(surface)
            .children(ring.then(|| ring_layer(focus::shadows(ds), radius)))
            .child(value)
            .children(badge)
            .child(
                div()
                    .flex_none()
                    .child(icon(Icon::ChevronDown, IconSize::Md, ds)),
            )
            .debug_selector(move || anchor.to_string());
        root = if self.disabled {
            root.cursor_default()
        } else {
            root.track_focus(&focus::tab_stop(&handle, true))
                .cursor_pointer()
                .children(focused.then(|| focus::publish(handle, room)))
        };
        if let Some(handler) = self.on_click {
            root = root.on_click(move |event, window, cx| handler(event, window, cx));
        }
        strut::flex_scope(false, root)
    }
}

fn geometry(
    size: Size,
    active: bool,
    focused: bool,
    ds: &Ds,
) -> (gpui::Pixels, gpui::Hsla, gpui::Pixels) {
    let radius = ds.len(if ds.compact() {
        Length::RadiusControlTouch
    } else {
        Length::RadiusControl
    });
    let line = ds.color(Color::Line);
    let accent = ds.color(Color::Accent);
    let border = if active {
        convert::mix(accent, line, 0.4)
    } else if focused {
        convert::mix(accent, line, 0.52)
    } else {
        line
    };
    let height = match size {
        Size::Default => ds.len(Length::ControlHeightLg),
        Size::Sm => ds.len(Length::ControlHeightMd),
    };
    let height = if ds.compact() {
        ds.len(Length::ControlHitTarget)
    } else {
        height
    };
    (radius, border, height)
}

/// The box: the raised fill and the border.
fn surface(border: gpui::Hsla, ds: &Ds) -> gpui::Div {
    div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .rounded(ds.len(if ds.compact() {
            Length::RadiusControlTouch
        } else {
            Length::RadiusControl
        }))
        .bg(convert::with_alpha(ds.color(Color::SurfaceRaised), 0.92))
        .border(ds.len(Length::BorderHairline))
        .border_color(border)
}

/// The count of chosen values.
fn badge(count: usize, ds: &Ds) -> gpui::Div {
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .min_w(ds.len(Length::SpaceLg))
        .h(ds.len(Length::SpaceLg))
        .px(ds.len(Length::SpaceXs))
        .rounded(ds.len(Length::RadiusPill))
        .bg(ds.color(Color::Accent))
        .text_color(ds.color(Color::NeutralWhite))
        .text_size(ds.len(Length::FontSize1))
        .line_height(ds.len(Length::TypoCaptionLineHeight))
        .font_weight(FontWeight(ds.number(Number::FontWeightMedium)))
        .child(count.to_string())
}
