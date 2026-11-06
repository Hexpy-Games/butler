//! DS IconButton (IconButton.tsx / IconButton.module.css): a ghost icon button named by its
//! label, shown as a tooltip. Tones colour the icon only; a pane toggle fills with its pane's
//! surface while pressed; an indicator dot and a count badge sit on the top-end corner.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, FontWeight, IntoElement, ParentElement, RenderOnce,
    SharedString, Styled as _, Window, div, linear_color_stop, linear_gradient, px,
};

use super::Icon;
use super::blocks::scope::{self, ActionScale};
use super::button::{Button, Size, Variant};
use super::context::Ds;
use super::control::{Blend, Control, Disabled, DisabledLook, Width, over};
use super::icon::icon_px;
use super::tooltip::Tooltip;
use crate::tokens::{Color, Length, Number};

/// Icon colour only, never a fill.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Tone {
    #[default]
    Default,
    /// `--butler-ink-blue`.
    Butler,
    /// The riso ink gradient: gpui draws an icon in one colour, so this is `--butler-ink-purple`,
    /// the CSS fallback of the gradient paint (card 11, `riso`).
    Riso,
}

/// The pane a title-bar toggle opens; while pressed it fills with that pane's surface.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pane {
    Aside,
    Browser,
    Viewer,
}

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent props, as the React IconButton API"
)]
#[derive(IntoElement)]
pub struct IconButton {
    id: ElementId,
    label: SharedString,
    icon: Option<AnyElement>,
    glyph: Option<Icon>,
    scale: Option<ActionScale>,
    selected: bool,
    optical_end: bool,
    tone: Tone,
    indicator: bool,
    badge: Option<u32>,
    pressed: Option<bool>,
    pane: Option<Pane>,
    disabled: Disabled,
    /// `aria-haspopup` / `aria-expanded`: a menu trigger shows no tooltip.
    menu: bool,
    on_click: Option<Handler>,
    /// `color: inherit` at rest (GlyphToggle) and its focus outline offset.
    inherit: Option<gpui::Hsla>,
    outline: Option<f32>,
}

impl IconButton {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            icon: None,
            glyph: None,
            scale: None,
            selected: false,
            optical_end: false,
            tone: Tone::Default,
            indicator: false,
            badge: None,
            pressed: None,
            pane: None,
            disabled: Disabled::No,
            menu: false,
            on_click: None,
            inherit: None,
            outline: None,
        }
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// A DS glyph at the icon size of the enclosing scope (`--icon-size-md` outside one): a
    /// title row or a sidebar resizes the svg of its buttons.
    pub fn glyph(mut self, glyph: Icon) -> Self {
        self.glyph = Some(glyph);
        self
    }

    pub fn selected(mut self) -> Self {
        self.selected = true;
        self
    }

    /// `opticalAlign="top-end"`.
    pub fn optical_top_end(mut self) -> Self {
        self.optical_end = true;
        self
    }

    pub fn tone(mut self, tone: Tone) -> Self {
        self.tone = tone;
        self
    }

    pub fn indicator(mut self) -> Self {
        self.indicator = true;
        self
    }

    pub fn badge(mut self, count: u32) -> Self {
        self.badge = Some(count);
        self
    }

    /// `aria-pressed`: paints no fill unless a pane is set.
    pub fn pressed(mut self, pressed: bool) -> Self {
        self.pressed = Some(pressed);
        self
    }

    pub fn pane(mut self, pane: Pane) -> Self {
        self.pane = Some(pane);
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = Disabled::Native;
        self
    }

    /// `aria-haspopup="menu"`: no tooltip.
    pub fn menu_trigger(mut self) -> Self {
        self.menu = true;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }

    /// The colour at rest is the container's, not `--text-secondary`.
    pub(crate) fn inherit_color(mut self, color: gpui::Hsla) -> Self {
        self.inherit = Some(color);
        self
    }

    /// A focus outline at this offset instead of the box-shadow ring.
    pub(crate) fn focus_outline(mut self, offset: f32) -> Self {
        self.outline = Some(offset);
        self
    }
}

impl IconButton {
    /// The pane's own surface made opaque (`rgb(from X r g b / 1)`).
    fn pane_fill(&self, ds: &Ds) -> Option<gpui::Hsla> {
        let pane = self.pane.filter(|_| self.pressed == Some(true))?;
        let token = match pane {
            Pane::Aside => Color::TintedGlassTint,
            Pane::Browser => Color::BrowserPaneBg,
            Pane::Viewer => Color::ShellCardBg,
        };
        Some(gpui::Hsla {
            alpha: 1.,
            ..ds.color(token)
        })
    }

    fn control(mut self, ds: &Ds) -> Control {
        let mut control = Button::new(self.id.clone())
            .variant(Variant::Ghost)
            .size(Size::IconSm)
            .control(ds);
        let size = self.scale.map_or_else(
            || f32::from(ds.len(Length::ControlHeightMd)),
            |scale| scale.side,
        );
        let side = if ds.compact() && !self.scale.is_some_and(|scale| scale.fixed) {
            size.max(f32::from(ds.len(Length::ControlHitTarget)))
        } else {
            size
        };
        control.width = Width::Fixed(side);
        control.height = Some(px(side));
        control.min_height = Some(px(side));
        control.radius = ds.len(Length::RadiusPill);
        control.disabled = self.disabled;
        control.disabled_look = DisabledLook::Opacity(0.42); // DS: IconButton.module.css:40
        control.on_click(self.on_click.take());
        let selection = ds.color(Color::Selection);
        let (secondary, primary) = (ds.color(Color::TextSecondary), ds.color(Color::TextPrimary));
        let (mut rest, mut hover) = (gpui::transparent_black(), selection);
        if let Some(fill) = self.pane_fill(ds) {
            rest = fill;
            hover = over(selection, fill);
        } else if self.selected {
            rest = selection;
        }
        control.fill = Blend::hover(rest, hover);
        control.fg = match self.tone {
            Tone::Default if self.selected => Blend::flat(primary),
            Tone::Default => Blend::hover(self.inherit.unwrap_or(secondary), primary),
            Tone::Butler => Blend::flat(ds.color(Color::ButlerInkBlue)),
            Tone::Riso if self.selected => Blend::flat(ds.color(Color::ButlerInkPurple)),
            Tone::Riso => Blend::hover(
                ds.color(Color::ButlerInkPurple),
                ds.color(Color::ButlerInkPurple),
            ),
        };
        control.padding = [px(0.); 4];
        if let Some(offset) = self.outline {
            control.ring = super::control::Ring::Outline(offset);
        }
        if self.optical_end {
            // The icon, not the hit area, meets the top-end corner.
            let offset = (side - f32::from(ds.len(Length::IconSizeMd))) / 2.;
            control.outer = Some(Box::new(move |el| {
                el.relative().left(px(offset)).top(px(-offset))
            }));
        }
        let glyph = self.glyph.map(|glyph| {
            let side = self
                .scale
                .map_or_else(|| ds.len(Length::IconSizeMd), |scale| px(scale.icon));
            icon_px(glyph, side).into_any_element()
        });
        control.children = glyph.into_iter().chain(self.icon.take()).collect();
        if self.indicator {
            control.children.push(indicator(ds, self.pane_fill(ds)));
        }
        if let Some(count) = self.badge.filter(|count| *count > 0) {
            control.children.push(badge(ds, count));
        }
        control
    }
}

/// The riso dot: 8px at top 3 / right 3 with a 1.5px ring in the surface colour.
fn indicator(ds: &Ds, ring: Option<gpui::Hsla>) -> AnyElement {
    let ink = |token| linear_color_stop(ds.color(token), 0.);
    let end = linear_color_stop(ds.color(Color::ButlerInkPink), 1.);
    let size = ds.len(Length::SpaceSm);
    div()
        .absolute()
        .top(px(3.)) // DS: IconButton.module.css:107
        .right(px(3.))
        .size(size)
        .border(px(1.5)) // DS: IconButton.module.css:111
        .border_color(ring.unwrap_or_else(|| ds.color(Color::WorkspaceBg)))
        .rounded(ds.len(Length::RadiusPill))
        .bg(linear_gradient(135., ink(Color::ButlerInkBlue), end))
        .into_any_element()
}

/// The count badge on the top-end corner (`99+` above 99).
fn badge(ds: &Ds, count: u32) -> AnyElement {
    let text = if count > 99 {
        "99+".to_owned()
    } else {
        count.to_string()
    };
    let lh = ds.len(Length::SpaceLg);
    let mut badge = div()
        .absolute()
        .top(px(-3.)) // DS: IconButton.module.css:119
        .right(px(-3.))
        .flex()
        .items_center()
        .justify_center()
        .min_w(lh)
        .h(lh)
        .px(ds.len(Length::SpaceXs))
        .rounded(ds.len(Length::RadiusPill))
        .bg(ds.color(Color::Accent))
        .text_color(ds.color(Color::NeutralWhite))
        .text_size(ds.len(Length::TypoCaptionSize))
        .font_weight(FontWeight(ds.number(Number::FontWeightSemibold)))
        .line_height(lh)
        .child(text);
    badge.text_style().font_features = Some(gpui::FontFeatures(std::sync::Arc::new(vec![(
        "tnum".to_owned(),
        1,
    )])));
    badge.into_any_element()
}

impl RenderOnce for IconButton {
    fn render(mut self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        self.scale = scope::action_scale(cx);
        let (id, label, menu) = (self.id.clone(), self.label.clone(), self.menu);
        let control = self.control(Ds::get(cx));
        if menu {
            return control.into_any_element();
        }
        Tooltip::new((id, "tooltip"))
            .label(label)
            .child(control)
            .into_any_element()
    }
}
