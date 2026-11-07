//! DS PillButton (PillButton.tsx / PillButton.module.css): a borderless pill Button, plain or
//! glass, that can be a pressed chip, carry a count or show the drop ring.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, IntoElement, ParentElement, RenderOnce, SharedString,
    Styled as _, Window, div, px,
};

use super::backdrop::Backdrop;
use super::button::{Button, Shape, Variant};
use super::context::Ds;
use super::control::{Blend, Control, Disabled};
use super::convert;
use crate::tokens::{Color, Filter, Length};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Surface {
    #[default]
    Plain,
    Glass,
}

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent props, as the React PillButton API"
)]
#[derive(IntoElement)]
pub struct PillButton {
    id: ElementId,
    icon: Option<AnyElement>,
    children: Vec<AnyElement>,
    text: Option<SharedString>,
    stretch: bool,
    surface: Surface,
    pressed: bool,
    count: Option<SharedString>,
    drop: bool,
    accent: bool,
    disabled: bool,
    on_click: Option<Handler>,
}

impl PillButton {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            icon: None,
            children: Vec::new(),
            text: None,
            stretch: false,
            surface: Surface::Plain,
            pressed: false,
            count: None,
            drop: false,
            accent: false,
            disabled: false,
            on_click: None,
        }
    }

    pub fn text(mut self, text: impl Into<SharedString>) -> Self {
        self.text = Some(text.into());
        self
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    pub fn stretch(mut self) -> Self {
        self.stretch = true;
        self
    }

    pub fn surface(mut self, surface: Surface) -> Self {
        self.surface = surface;
        self
    }

    /// A toggle or the chosen chip of a row (`aria-pressed`): flat selection background.
    pub fn pressed(mut self, pressed: bool) -> Self {
        self.pressed = pressed;
        self
    }

    /// A quiet number after the label.
    pub fn count(mut self, count: impl Into<SharedString>) -> Self {
        self.count = Some(count.into());
        self
    }

    /// A drag is over the chip: the accent drop ring.
    pub fn drop_target(mut self) -> Self {
        self.drop = true;
        self
    }

    /// An accent edge and accent text (the scroll-to-bottom chip while messages are unread).
    pub fn accent(mut self, accent: bool) -> Self {
        self.accent = accent;
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
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

impl ParentElement for PillButton {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl PillButton {
    /// The label: the text, then the count span after `--space-xs`.
    fn label(&mut self, ds: &Ds) -> Option<AnyElement> {
        let count = self.count.take();
        let text = self.text.take();
        if count.is_none() {
            return text.map(IntoElement::into_any_element);
        }
        let mut row = div().flex().items_center().children(text);
        if let Some(count) = count {
            let mut tail = div()
                .ml(ds.len(Length::SpaceXs))
                .text_color(ds.color(Color::TextTertiary))
                .child(count);
            tail.text_style().font_features =
                Some(gpui::FontFeatures(std::sync::Arc::new(vec![(
                    "tnum".to_owned(),
                    1,
                )])));
            row = row.child(tail);
        }
        Some(row.into_any_element())
    }

    pub(crate) fn control(mut self, ds: &Ds) -> Control {
        let mut button = Button::new(self.id.clone())
            .variant(Variant::Borderless)
            .shape(Shape::Pill);
        if self.stretch {
            button = button.stretch();
        }
        if self.disabled {
            button = button.disabled();
        }
        if let Some(icon) = self.icon.take() {
            button = button.icon_start(icon);
        }
        if let Some(label) = self.label(ds) {
            button = button.child(label);
        }
        button = button.children_from(std::mem::take(&mut self.children));
        let mut control = button.control(ds);
        control.on_click(self.on_click.take());
        control.disabled = if self.disabled {
            Disabled::Native
        } else {
            Disabled::No
        };
        let selection = ds.color(Color::Selection);
        if self.surface == Surface::Glass {
            Self::glass(&mut control, ds);
        }
        if self.accent {
            // `color-mix(in srgb, var(--accent) 58%, var(--line))`
            let edge = convert::mix(ds.color(Color::Accent), ds.color(Color::Line), 0.58); // DS: ConversationShell.module.css:216
            control.border = Some((px(1.), Blend::hover(edge, ds.color(Color::LineStrong))));
            control.fg = Blend::flat(ds.color(Color::AccentText));
        }
        if self.pressed {
            control.fill = Blend::hover(ds.color(Color::SelectionStrong), selection);
            control.fg = Blend::flat(ds.color(Color::TextPrimary));
        }
        if self.drop {
            control.fill = Blend::hover(
                convert::with_alpha(ds.color(Color::Accent), 0.10), // DS: PillButton.module.css:47
                selection,
            );
            control.fg = Blend::flat(ds.color(Color::AccentText));
            control.overlay.push(drop_ring(ds, control.radius));
        }
        control
    }

    /// The glass capsule: border, fill, card shadow and backdrop blur.
    fn glass(control: &mut Control, ds: &Ds) {
        control.border = Some((
            px(1.), // DS: PillButton.module.css:6
            Blend::hover(
                ds.color(Color::ComposerGlassBorder),
                ds.color(Color::LineStrong),
            ),
        ));
        let (left, top, right, bottom) = (
            control.padding[0],
            control.padding[1],
            control.padding[2],
            control.padding[3],
        );
        control.padding = [left + px(1.), top + px(1.), right + px(1.), bottom + px(1.)];
        control.fill = Blend::hover(
            ds.color(Color::ComposerGlassBg),
            ds.color(Color::ComposerGlassControlBg),
        );
        control.fg = Blend::flat(ds.color(Color::TextPrimary));
        control.text_size = ds.len(Length::FontSize2);
        control.shadows = convert::box_shadows(
            ds.tokens().shadow(crate::tokens::Shadow::ShadowCard),
            ds.tokens(),
        );
        control.backdrop = Some(Backdrop::new(ds, Filter::ComposerGlassFilter));
        let floor = ds.len(Length::Space4) * 2.;
        control.min_height = Some(if ds.compact() {
            ds.len(Length::ControlHitTarget)
        } else {
            floor
        });
    }
}

/// `inset 0 0 0 var(--border-width-strong) var(--accent)`.
fn drop_ring(ds: &Ds, radius: gpui::Pixels) -> AnyElement {
    div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .rounded(radius)
        .border(ds.len(Length::BorderWidthStrong))
        .border_color(ds.color(Color::Accent))
        .into_any_element()
}

impl RenderOnce for PillButton {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        self.control(Ds::get(cx))
    }
}
