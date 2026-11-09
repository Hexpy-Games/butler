//! DS Clickable (Clickable.tsx / Clickable.module.css): a `role="button"` row or bare-text
//! target with hover and pressed fills, toggle selection, gutter bleed and the focus ring.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, Entity, FocusHandle, IntoElement, ParentElement,
    Pixels, RenderOnce, Styled as _, Window, px,
};

use super::context::Ds;
use super::control::{Blend, Control, Disabled, DisabledLook, Ring, State, Width};
use super::convert;
use crate::tokens::{Color, Length};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Variant {
    /// A padded row target with a hover fill.
    #[default]
    Row,
    /// Bare text that dims on hover.
    Text,
}

/// The row reaches into its container's gutter (row variant only).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bleed {
    /// Content lines up with siblings; the fills extend past it by the inline padding.
    Inline,
    /// The fills reach above and below by the block padding; the content stays put.
    Block,
    Both,
}

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Clickable {
    id: ElementId,
    variant: Variant,
    bleed: Option<Bleed>,
    selected: Option<bool>,
    stretch: bool,
    disabled: bool,
    /// `--clickable-padding-inline` and `--clickable-min-height`, when a block sets its own.
    metrics: Option<(Pixels, Pixels)>,
    /// The hover and selected fills a surface sets (`--nav-hover-bg`, `--nav-selected-bg`).
    fills: Option<(gpui::Hsla, gpui::Hsla)>,
    state: Option<Entity<State>>,
    focus: Option<FocusHandle>,
    on_click: Option<Handler>,
    children: Vec<AnyElement>,
}

impl Clickable {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            variant: Variant::Row,
            bleed: None,
            selected: None,
            stretch: false,
            disabled: false,
            metrics: None,
            fills: None,
            state: None,
            focus: None,
            on_click: None,
            children: Vec::new(),
        }
    }

    pub fn variant(mut self, variant: Variant) -> Self {
        self.variant = variant;
        self
    }

    pub fn bleed(mut self, bleed: Bleed) -> Self {
        self.bleed = Some(bleed);
        self
    }

    /// Makes the row a toggle (`aria-pressed`): `true` shows the selected fill.
    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = Some(selected);
        self
    }

    pub fn stretch(mut self) -> Self {
        self.stretch = true;
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    pub(crate) fn state(mut self, state: Entity<State>) -> Self {
        self.state = Some(state);
        self
    }

    pub(crate) fn focus(mut self, focus: FocusHandle) -> Self {
        self.focus = Some(focus);
        self
    }

    /// The row's inline padding and minimum height (a block sets `--clickable-padding-inline`
    /// and `--clickable-min-height`, as NavRow does for its density).
    pub fn metrics(mut self, padding_inline: Pixels, min_height: Pixels) -> Self {
        self.metrics = Some((padding_inline, min_height));
        self
    }

    /// The hover fill and the selected (and pressed) fill, in place of the `--selection` shades.
    pub fn fills(mut self, hover: gpui::Hsla, selected: gpui::Hsla) -> Self {
        self.fills = Some((hover, selected));
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

impl ParentElement for Clickable {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// `--clickable-padding-inline`, `--clickable-min-height`.
const PADDING_INLINE: f32 = 10.; // DS: Clickable.module.css:2
const MIN_HEIGHT: f32 = 30.; // DS: Clickable.module.css:4

impl Clickable {
    fn control(mut self, ds: &Ds) -> Control {
        let mut control = Control::new(self.id.clone(), ds);
        control.state = self.state.take();
        control.focus = self.focus.take();
        control.disabled = if self.disabled {
            Disabled::Native
        } else {
            Disabled::No
        };
        control.disabled_look = DisabledLook::Text;
        control.radius = ds.len(Length::RadiusControl);
        control.justify_center = false;
        control.on_click(self.on_click.take());
        control.children = std::mem::take(&mut self.children);
        let selection = ds.color(Color::Selection);
        let strong = ds.color(Color::SelectionStrong);
        let (selection, strong, shaded) = match self.fills {
            Some((hover, selected)) => (hover, selected, false),
            None => (selection, strong, true),
        };
        if self.variant == Variant::Text {
            let secondary = ds.color(Color::TextSecondary);
            control.fg = Blend {
                rest: ds.color(Color::TextPrimary),
                hover: secondary,
                active: Some(secondary),
            };
            control.scale = false;
            control.ring = Ring::Outline(f32::from(ds.len(Length::SpaceXs)));
            if self.stretch {
                // `width: 100%`, as the row variant's stretch.
                control.inline = false;
                control.width = Width::Full;
            }
            return control;
        }
        let hover = match self.selected {
            Some(_) if shaded => convert::with_alpha(selection, 0.6), // DS: Clickable.module.css:84
            _ => selection,
        };
        control.fill = match self.selected {
            Some(true) => Blend {
                rest: strong,
                hover: strong,
                active: Some(strong),
            },
            _ => Blend {
                rest: gpui::transparent_black(),
                hover,
                active: Some(strong),
            },
        };
        control.scale = !self.stretch;
        self.row_box(&mut control, ds);
        control
    }

    /// Padding, minimum height and the gutter bleed of the row variant.
    fn row_box(&self, control: &mut Control, ds: &Ds) {
        let block = ds.len(Length::SpaceXs);
        let (inline_bleed, block_bleed) = (
            matches!(self.bleed, Some(Bleed::Inline | Bleed::Both)),
            matches!(self.bleed, Some(Bleed::Block | Bleed::Both)),
        );
        // Block bleed: the fill reaches `--space-xs` above and below while the box keeps the
        // space of an unbled row (the CSS grows the padding and takes it back with margins).
        let (inline, min_height) = self.metrics.unwrap_or((px(PADDING_INLINE), px(MIN_HEIGHT)));
        control.padding = [inline, px(0.), inline, px(0.)];
        control.min_height = Some(min_height);
        if block_bleed {
            control.bleed_y = block;
        }
        control.inline = !self.stretch;
        if self.stretch {
            // `width: 100%`; with the bleed, `calc(100% + 2 * padding)` is the stretched box
            // between its negative margins.
            control.width = if inline_bleed {
                Width::Stretch
            } else {
                Width::Full
            };
        }
        if inline_bleed {
            let margin_x = -inline;
            control.outer = Some(Box::new(move |el| el.ml(margin_x).mr(margin_x)));
        }
    }
}

impl RenderOnce for Clickable {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        self.control(Ds::get(cx))
    }
}
