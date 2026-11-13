//! DS Button (shadcn/ui/button.tsx, Button.module.css): variants, sizes, the pill shape, an
//! icon before and after the text, `stretch`, the two disabled forms and the focus ring.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, IntoElement, ParentElement, RenderOnce, SharedString,
    Styled as _, Window, div, px,
};

use super::blocks::scope::{self, Spec};
use super::context::Ds;
use super::control::{Blend, Control, Disabled, Underline, Width};
use super::convert;
use crate::tokens::{Color, Length, Number};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Variant {
    #[default]
    Default,
    Outline,
    Borderless,
    Inline,
    Secondary,
    Ghost,
    Destructive,
    Link,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Size {
    #[default]
    Default,
    Xs,
    Sm,
    Lg,
    Icon,
    IconXs,
    IconSm,
    IconLg,
}

impl Size {
    fn icon(self) -> bool {
        matches!(
            self,
            Self::Icon | Self::IconXs | Self::IconSm | Self::IconLg
        )
    }

    fn height(self) -> Length {
        match self {
            Self::Default | Self::Icon => Length::ControlHeightMd,
            Self::Xs | Self::IconXs => Length::ControlHeightXs,
            Self::Sm | Self::IconSm => Length::ControlHeightSm,
            Self::Lg | Self::IconLg => Length::ControlHeightLg,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Shape {
    #[default]
    Default,
    Pill,
}

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Button {
    id: ElementId,
    variant: Variant,
    size: Size,
    shape: Shape,
    stretch: bool,
    icon_start: Option<AnyElement>,
    icon_end: Option<AnyElement>,
    text: Option<SharedString>,
    children: Vec<AnyElement>,
    disabled: Disabled,
    on_click: Option<Handler>,
}

impl Button {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            variant: Variant::Default,
            size: Size::Default,
            shape: Shape::Default,
            stretch: false,
            icon_start: None,
            icon_end: None,
            text: None,
            children: Vec::new(),
            disabled: Disabled::No,
            on_click: None,
        }
    }

    pub fn variant(mut self, variant: Variant) -> Self {
        self.variant = variant;
        self
    }

    pub fn size(mut self, size: Size) -> Self {
        self.size = size;
        self
    }

    pub fn shape(mut self, shape: Shape) -> Self {
        self.shape = shape;
        self
    }

    pub fn stretch(mut self) -> Self {
        self.stretch = true;
        self
    }

    pub fn icon_start(mut self, icon: impl IntoElement) -> Self {
        self.icon_start = Some(icon.into_any_element());
        self
    }

    pub fn icon_end(mut self, icon: impl IntoElement) -> Self {
        self.icon_end = Some(icon.into_any_element());
        self
    }

    pub fn text(mut self, text: impl Into<SharedString>) -> Self {
        self.text = Some(text.into());
        self
    }

    pub(crate) fn children_from(mut self, children: Vec<AnyElement>) -> Self {
        self.children.extend(children);
        self
    }

    /// `disabled`: not focusable, no activation.
    pub fn disabled(mut self) -> Self {
        self.disabled = Disabled::Native;
        self
    }

    /// `aria-disabled`: focusable and hoverable, activation blocked.
    pub fn aria_disabled(mut self) -> Self {
        self.disabled = Disabled::Aria;
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

impl ParentElement for Button {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// The resting colours of a variant.
struct Palette {
    fill: Blend,
    fg: gpui::Hsla,
    border: Option<gpui::Hsla>,
    underline: Underline,
}

fn palette(variant: Variant, ds: &Ds) -> Palette {
    let none = gpui::transparent_black();
    let selection = ds.color(Color::Selection);
    let hovered = |rest| Blend::hover(rest, selection);
    let flat = |fill, fg, border| Palette {
        fill,
        fg,
        border,
        underline: Underline::Never,
    };
    match variant {
        Variant::Default => {
            let primary = ds.color(Color::Primary);
            let hover = convert::mix(primary, ds.color(Color::ColorMixLight), 0.88);
            flat(
                Blend::hover(primary, hover),
                ds.color(Color::PrimaryForeground),
                None,
            )
        }
        Variant::Outline => flat(
            hovered(convert::with_alpha(ds.color(Color::SurfaceRaised), 0.86)), // DS: Button.module.css:62
            ds.color(Color::TextPrimary),
            Some(ds.color(Color::Line)),
        ),
        Variant::Borderless => flat(hovered(none), ds.color(Color::TextSecondary), None),
        Variant::Ghost => flat(hovered(none), ds.color(Color::TextPrimary), None),
        Variant::Destructive => {
            let danger = ds.color(Color::Danger);
            flat(
                hovered(convert::with_alpha(danger, 0.12)), // DS: Button.module.css:80
                danger,
                None,
            )
        }
        Variant::Secondary => flat(
            hovered(ds.color(Color::Secondary)),
            ds.color(Color::SecondaryForeground),
            Some(ds.color(Color::SecondaryBorder)),
        ),
        Variant::Link => Palette {
            underline: Underline::Always,
            ..flat(hovered(none), ds.color(Color::Primary), None)
        },
        Variant::Inline => Palette {
            underline: Underline::OnHover,
            ..flat(Blend::flat(none), ds.color(Color::TextSecondary), None)
        },
    }
}

impl Button {
    /// The control this button draws: the shared core with the variant's colours and the
    /// size's box. IconButton and PillButton refine it before it renders.
    pub(crate) fn control(mut self, ds: &Ds) -> Control {
        let colors = palette(self.variant, ds);
        let bare = matches!(self.variant, Variant::Link | Variant::Inline);
        let icon_only = self.size.icon();
        let has_text = self.text.is_some() || !self.children.is_empty();
        let mut control = Control::new(self.id.clone(), ds);
        control.fill = colors.fill;
        control.fg = Blend::flat(colors.fg);
        control.disabled = self.disabled;
        control.on_click(self.on_click.take());
        control.underline = colors.underline;
        control.gap = px(5.); // DS: Button.module.css:10
        let border = colors.border.map(|color| {
            let width = if self.variant == Variant::Secondary {
                ds.len(Length::BorderHairline)
            } else {
                px(1.) // DS: Button.module.css:61
            };
            (width, Blend::flat(color))
        });
        let border_width = border.map_or(px(0.), |(width, _)| width);
        control.border = border;
        control.radius = match (self.shape, self.variant) {
            (Shape::Pill, _) => ds.len(Length::RadiusPill),
            (_, Variant::Inline) => px(0.),
            _ => ds.len(Length::RadiusControl),
        };
        if self.size == Size::Xs {
            control.text_size = ds.len(Length::FontSize2);
        }
        let side = if bare || icon_only {
            px(0.)
        } else if self.size == Size::Xs {
            ds.len(Length::SpaceSm)
        } else {
            px(10.) // DS: Button.module.css:11
        };
        let (mut left, mut right) = (side, side);
        let iconed = has_text && (self.icon_start.is_some() || self.icon_end.is_some());
        if iconed && !bare {
            // DS: Button.module.css:204
            match (self.icon_start.is_some(), self.icon_end.is_some()) {
                (true, false) => right = px(14.),
                (false, true) => left = px(14.),
                _ => {}
            }
        }
        control.padding = [
            left + border_width,
            border_width,
            right + border_width,
            border_width,
        ];
        if !matches!(self.variant, Variant::Link | Variant::Inline) {
            self.sized(&mut control, ds);
        }
        if self.stretch {
            control.width = Width::Full;
        }
        self.touch_layout(&mut control, ds, border_width);
        control.children = self.content(ds);
        control
    }

    fn touch_layout(&self, control: &mut Control, ds: &Ds, border: gpui::Pixels) {
        if !ds.compact()
            || self.size.icon()
            || matches!(self.variant, Variant::Link | Variant::Inline)
        {
            return;
        }
        control.gap = ds.len(Length::SpaceSm);
        control.text_size = ds.len(Length::FontSize4);
        control.line_height = Some(ds.len(Length::TypoAppTitleLineHeight));
        control.weight = ds.number(Number::FontWeightMedium);
        if self.shape != Shape::Pill {
            control.radius = ds.len(Length::RadiusControlTouch);
        }
        let (mut left, mut right) = (Length::SpaceLg, Length::SpaceLg);
        let has_text = self.text.is_some() || !self.children.is_empty();
        if has_text {
            match (self.icon_start.is_some(), self.icon_end.is_some()) {
                (true, false) => left = Length::SpaceMd,
                (false, true) => right = Length::SpaceMd,
                _ => {}
            }
        }
        control.padding = [
            ds.len(left) + border,
            border,
            ds.len(right) + border,
            border,
        ];
    }

    /// Height or square size, raised to the hit target on mobile.
    fn sized(&self, control: &mut Control, ds: &Ds) {
        let height = ds.len(self.size.height());
        let hit = ds.len(Length::ControlHitTarget);
        control.height = Some(height);
        control.min_height = Some(height);
        if ds.compact() {
            control.min_height = Some(hit);
        }
        if self.size.icon() {
            let side = if ds.compact() { hit } else { height };
            control.width = Width::Fixed(f32::from(side));
            control.height = Some(side);
            control.min_height = Some(side);
        }
    }

    fn content(&mut self, ds: &Ds) -> Vec<AnyElement> {
        let touch_label = ds.compact()
            && !self.size.icon()
            && !matches!(self.variant, Variant::Link | Variant::Inline);
        let size = self.size;
        let sized_icon = |element| touch_icon(element, size, touch_label, ds);
        let slot = |element: AnyElement| {
            div()
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .child(sized_icon(element))
                .into_any_element()
        };
        // `hasStructuredContent` (button.tsx): only `text` or an icon puts the content in spans
        // of `line-height: 1`.
        let structured =
            self.text.is_some() || self.icon_start.is_some() || self.icon_end.is_some();
        let mut out = Vec::new();
        out.extend(self.icon_start.take().map(slot));
        let line = ds.len(if touch_label {
            Length::FontSize4
        } else if self.size == Size::Xs {
            Length::FontSize2
        } else {
            Length::FontSize3
        });
        let label = |content: AnyElement| {
            div()
                .flex()
                .min_w_0()
                .items_center()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .line_height(line) // `line-height: 1` of the text span
                .child(sized_icon(content))
                .into_any_element()
        };
        if let Some(text) = self.text.take() {
            out.push(label(text.into_any_element()));
        }
        let children = std::mem::take(&mut self.children);
        if structured {
            out.extend(children.into_iter().map(label));
        } else {
            // Plain children are the button's own content, at the inherited line height.
            out.extend(children.into_iter().map(sized_icon));
        }
        out.extend(self.icon_end.take().map(slot));
        out
    }
}

fn touch_icon(element: AnyElement, size: Size, label: bool, ds: &Ds) -> AnyElement {
    let token = if ds.compact() && size.icon() {
        Length::IconSizeLg
    } else if label {
        Length::FontSize4
    } else {
        return element;
    };
    scope::scoped(
        Spec {
            svg_size: Some(f32::from(ds.len(token))),
            ..Spec::default()
        },
        element,
    )
    .into_any_element()
}

impl RenderOnce for Button {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        self.control(Ds::get(cx))
    }
}

/// `ButtonContainer`: a row of buttons of one size, centred and wrapping, with the gap that
/// size takes.
pub fn container(size: Size) -> super::layout::Stack {
    use super::layout::{Cross, Space, Stack};
    let gap = match size {
        Size::Xs | Size::IconXs => Space::Xs,
        Size::Lg | Size::IconLg => Space::Md,
        _ => Space::Sm,
    };
    Stack::row().cross(Cross::Center).gap(gap).wrap(true)
}
