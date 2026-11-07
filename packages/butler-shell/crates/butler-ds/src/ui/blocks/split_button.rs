//! DS SplitButton (SplitButton.tsx / SplitButton.module.css): a primary action joined to a menu of
//! related actions ("Allow once" plus "Allow for this conversation"). The halves share one
//! outline; the arrow is a hit-target-wide button that opens the menu.
use std::rc::Rc;

use gpui::{
    App, ClickEvent, ElementId, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _,
    Window, div,
};

use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::button::{Button, Size as ButtonSize, Variant as ButtonVariant};
use crate::ui::context::Ds;
use crate::ui::control::Control;
use crate::ui::convert;
use crate::ui::dropdown_menu::{DropdownMenu, DropdownMenuContent, Item};
use crate::ui::icon::{IconSize, icon};
use crate::ui::overlay::place::{Align, Side};

type Select = Rc<dyn Fn(&mut Window, &mut App)>;
type Click = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// One menu action: its label, optional secondary lines (each wraps anywhere), and what it does.
pub struct SplitItem {
    label: SharedString,
    description: Vec<SharedString>,
    disabled: bool,
    on_select: Select,
}

impl SplitItem {
    pub fn new(
        label: impl Into<SharedString>,
        on_select: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            label: label.into(),
            description: Vec::new(),
            disabled: false,
            on_select: Rc::new(on_select),
        }
    }

    pub fn description(mut self, lines: impl IntoIterator<Item = SharedString>) -> Self {
        self.description = lines.into_iter().collect();
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SplitSize {
    Sm,
    #[default]
    Default,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SplitVariant {
    #[default]
    Primary,
    Outline,
}

#[derive(IntoElement)]
pub struct SplitButton {
    name: SharedString,
    id: ElementId,
    text: SharedString,
    on_click: Click,
    size: SplitSize,
    variant: SplitVariant,
    disabled: bool,
    menu_side: Side,
    items: Vec<SplitItem>,
}

impl SplitButton {
    /// `text` is the primary action's label.
    pub fn new(
        id: impl Into<SharedString>,
        text: impl Into<SharedString>,
        on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        let name: SharedString = id.into();
        Self {
            id: name.clone().into(),
            name,
            text: text.into(),
            on_click: Rc::new(on_click),
            size: SplitSize::Default,
            variant: SplitVariant::Primary,
            disabled: false,
            menu_side: Side::Bottom,
            items: Vec::new(),
        }
    }

    pub fn size(mut self, size: SplitSize) -> Self {
        self.size = size;
        self
    }

    pub fn variant(mut self, variant: SplitVariant) -> Self {
        self.variant = variant;
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    pub fn menu_side(mut self, side: Side) -> Self {
        self.menu_side = side;
        self
    }

    pub fn item(mut self, item: SplitItem) -> Self {
        self.items.push(item);
        self
    }
}

impl SplitButton {
    fn half(&self, id: (ElementId, &'static str)) -> Button {
        let (variant, size) = (
            match self.variant {
                SplitVariant::Primary => ButtonVariant::Default,
                SplitVariant::Outline => ButtonVariant::Outline,
            },
            match self.size {
                SplitSize::Sm => ButtonSize::Sm,
                SplitSize::Default => ButtonSize::Default,
            },
        );
        Button::new(id).variant(variant).size(size)
    }

    /// The primary action: square inner corners.
    fn action(&self, ds: &Ds) -> Control {
        let mut button = self
            .half((self.id.clone(), "action"))
            .text(self.text.clone());
        if self.disabled {
            button = button.disabled();
        }
        let mut control = button.control(ds);
        let on_click = self.on_click.clone();
        control.on_click(Some(on_click));
        control.square = [false, true];
        control
    }

    /// The arrow: a hit-target-wide button, square inner corners, one seam.
    fn arrow(
        &self,
        toggle: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
        ds: &Ds,
    ) -> Control {
        let menu_disabled = self.disabled || self.items.iter().all(|item| item.disabled);
        let mut button = self.half((self.id.clone(), "arrow")).icon_start(icon(
            Icon::ChevronDown,
            IconSize::Md,
            ds,
        ));
        if menu_disabled {
            button = button.disabled();
        }
        let mut control = button.control(ds);
        control.on_click(Some(Rc::new(toggle)));
        control.square = [true, false];
        // `min-inline-size: var(--control-hit-target)` around the 16px glyph.
        let glyph = ds.len(Length::IconSizeMd);
        let side = ds
            .len(Length::Space2)
            .max((ds.len(Length::ControlHitTarget) - glyph) / 2.);
        control.padding = [side, control.padding[1], side, control.padding[3]];
        if self.variant == SplitVariant::Primary {
            // `inset var(--border-hairline) 0 0 color-mix(in srgb, var(--primary-foreground) 24%, transparent)`
            let seam = convert::with_alpha(ds.color(Color::PrimaryForeground), 0.24); // DS: SplitButton.module.css:28
            control.overlay.push(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left_0()
                    .w(ds.len(Length::BorderHairline))
                    .bg(seam)
                    .into_any_element(),
            );
        } else {
            let hairline = ds.len(Length::BorderHairline);
            control.outer = Some(Box::new(move |el| el.ml(-hairline)));
        }
        control
    }
}

impl RenderOnce for SplitButton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let menu = DropdownMenu::new(self.name.clone(), window, cx);
        let ds = Ds::get(cx);
        let action = self.action(ds);
        let trigger = menu.trigger(|toggle| self.arrow(toggle.on_click(), ds).into_any_element());
        let mut content = DropdownMenuContent::new()
            .side(self.menu_side)
            .align(Align::End);
        for item in self.items {
            let mut entry = Item::new(item.label).description(item.description);
            if item.disabled {
                entry = entry.disabled();
            }
            let on_select = item.on_select;
            content = content.child(entry.on_select(move |window, cx| on_select(window, cx)));
        }
        let content = menu.content(content, window, cx);
        div()
            .flex()
            .flex_none()
            .max_w_full()
            .child(action)
            .child(trigger)
            .child(content)
            .into_any_element()
    }
}
