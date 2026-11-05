//! DS Box (Box.tsx / Box.module.css): a block container with padding, radius, surface, border
//! and elevation from tokens.
use gpui::{
    AnyElement, App, Div, IntoElement, ParentElement, Pixels, RenderOnce, Styled as _, Window, div,
    px,
};

use super::{ItemProps, Space, WithItem};
use crate::tokens::{Color, Length, Shadow};
use crate::ui::context::Ds;
use crate::ui::convert;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Radius {
    #[default]
    None,
    Control,
    Panel,
    Popover,
    Pill,
}

impl Radius {
    pub fn px(self, ds: &Ds) -> Pixels {
        match self {
            Self::None => px(0.),
            Self::Control => ds.len(Length::RadiusControl),
            Self::Panel => ds.len(Length::RadiusPanel),
            Self::Popover => ds.len(Length::RadiusPopover),
            Self::Pill => ds.len(Length::RadiusPill),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Surface {
    #[default]
    None,
    Base,
    Raised,
    RaisedOpaque,
    Overlay,
    Muted,
}

impl Surface {
    fn color(self) -> Option<Color> {
        match self {
            Self::None => None,
            Self::Base => Some(Color::Surface),
            Self::Raised => Some(Color::SurfaceRaised),
            Self::RaisedOpaque => Some(Color::ColorSurfaceRaisedOpaque),
            Self::Overlay => Some(Color::ColorSurfaceOverlay),
            Self::Muted => Some(Color::Muted),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Border {
    #[default]
    None,
    /// `--border-hairline` solid `--line`.
    Hairline,
    /// `--border-width-strong` solid `--line-strong`.
    Strong,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Elevation {
    #[default]
    None,
    Card,
}

#[derive(IntoElement)]
pub struct Box {
    padding: Space,
    padding_x: Option<Space>,
    padding_y: Option<Space>,
    padding_start: Option<Space>,
    radius: Radius,
    surface: Surface,
    border: Border,
    elevation: Elevation,
    item: ItemProps,
    children: Vec<AnyElement>,
}

impl Box {
    pub fn new() -> Self {
        Self {
            padding: Space::None,
            padding_x: None,
            padding_y: None,
            padding_start: None,
            radius: Radius::None,
            surface: Surface::None,
            border: Border::None,
            elevation: Elevation::None,
            item: ItemProps::default(),
            children: Vec::new(),
        }
    }

    pub fn padding(mut self, padding: Space) -> Self {
        self.padding = padding;
        self
    }

    pub fn padding_x(mut self, padding: Space) -> Self {
        self.padding_x = Some(padding);
        self
    }

    pub fn padding_y(mut self, padding: Space) -> Self {
        self.padding_y = Some(padding);
        self
    }

    /// The inline-start side only; it wins over `padding` and `padding_x` there.
    pub fn padding_start(mut self, padding: Space) -> Self {
        self.padding_start = Some(padding);
        self
    }

    pub fn radius(mut self, radius: Radius) -> Self {
        self.radius = radius;
        self
    }

    pub fn surface(mut self, surface: Surface) -> Self {
        self.surface = surface;
        self
    }

    pub fn border(mut self, border: Border) -> Self {
        self.border = border;
        self
    }

    pub fn elevation(mut self, elevation: Elevation) -> Self {
        self.elevation = elevation;
        self
    }
}

impl Default for Box {
    fn default() -> Self {
        Self::new()
    }
}

impl WithItem for Box {
    fn item_mut(&mut self) -> &mut ItemProps {
        &mut self.item
    }
}

impl ParentElement for Box {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for Box {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let space = |space: Space| space.px(ds);
        let x = self.padding_x.unwrap_or(self.padding);
        let y = self.padding_y.unwrap_or(self.padding);
        let mut el = div()
            .min_w_0()
            .pt(space(y))
            .pb(space(y))
            .pr(space(x))
            .pl(space(self.padding_start.unwrap_or(x)))
            .rounded(self.radius.px(ds));
        if let Some(color) = self.surface.color() {
            el = el.bg(ds.color(color));
        }
        el = border(el, self.border, ds);
        if self.elevation == Elevation::Card {
            el = el.shadow(convert::box_shadows(
                ds.tokens().shadow(Shadow::ShadowCard),
                ds.tokens(),
            ));
        }
        self.item.apply(el, ds).children(self.children)
    }
}

fn border(el: Div, border: Border, ds: &Ds) -> Div {
    match border {
        Border::None => el,
        Border::Hairline => el
            .border(ds.len(Length::BorderHairline))
            .border_color(ds.color(Color::Line)),
        Border::Strong => el
            .border(ds.len(Length::BorderWidthStrong))
            .border_color(ds.color(Color::LineStrong)),
    }
}
