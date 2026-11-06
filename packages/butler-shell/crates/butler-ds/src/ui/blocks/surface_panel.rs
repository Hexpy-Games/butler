//! DS SurfacePanel (SurfacePanel.tsx / SurfacePanel.module.css): a bordered raised panel whose
//! elevation is a shadow token; `subtle` is a flat translucent fill and `none` has no fill.
use gpui::{AnyElement, App, IntoElement, ParentElement, RenderOnce, Styled as _, Window, div, px};

use crate::tokens::{Color, Length, Shadow};
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::layout::{ItemProps, WithItem};
use crate::ui::strut;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Elevation {
    None,
    Subtle,
    #[default]
    Low,
    Medium,
    High,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PanelRadius {
    #[default]
    Control,
    /// `--radius-popover`, for a panel in the conversation beside bubbles.
    Lg,
}

/// `color-mix(in srgb, var(--surface-raised) 72%, transparent)` of the subtle fill.
const SUBTLE_SHARE: f32 = 0.72; // DS: SurfacePanel.module.css:22

#[derive(IntoElement)]
pub struct SurfacePanel {
    elevation: Elevation,
    radius: PanelRadius,
    item: ItemProps,
    children: Vec<AnyElement>,
}

impl SurfacePanel {
    pub fn new() -> Self {
        Self {
            elevation: Elevation::Low,
            radius: PanelRadius::Control,
            item: ItemProps::default(),
            children: Vec::new(),
        }
    }

    pub fn elevation(mut self, elevation: Elevation) -> Self {
        self.elevation = elevation;
        self
    }

    pub fn radius(mut self, radius: PanelRadius) -> Self {
        self.radius = radius;
        self
    }
}

impl Default for SurfacePanel {
    fn default() -> Self {
        Self::new()
    }
}

impl WithItem for SurfacePanel {
    fn item_mut(&mut self) -> &mut ItemProps {
        &mut self.item
    }
}

impl ParentElement for SurfacePanel {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for SurfacePanel {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let raised = ds.color(Color::SurfaceRaised);
        let shadow = |token| convert::box_shadows(ds.tokens().shadow(token), ds.tokens());
        let mut el = div()
            .w_full()
            .min_w_0()
            .p(ds.len(Length::SpaceMd))
            .border(px(1.)) // DS: SurfacePanel.module.css:5
            .border_color(ds.color(Color::Line))
            .rounded(ds.len(match self.radius {
                PanelRadius::Control => Length::RadiusControl,
                PanelRadius::Lg => Length::RadiusPopover,
            }))
            .text_color(ds.color(Color::TextPrimary));
        el = match self.elevation {
            Elevation::None => el,
            Elevation::Subtle => el.bg(convert::with_alpha(raised, SUBTLE_SHARE)),
            Elevation::Low => el.bg(raised).shadow(shadow(Shadow::ShadowControl)),
            Elevation::Medium => el.bg(raised).shadow(shadow(Shadow::ShadowCard)),
            Elevation::High => el.bg(raised).shadow(shadow(Shadow::ShadowWindow)),
        };
        strut::scope(
            true,
            strut::container(self.item.apply(el, ds), ds).children(self.children),
        )
    }
}
