//! The actions of a SelectionBar: a worded ghost button on a wide bar, an icon button with the
//! same words as its tooltip on a narrow one, and the unavailable forms of both.
use std::rc::Rc;

use gpui::{AnyElement, App, ElementId, IntoElement, ParentElement as _, SharedString, Window};

use crate::ui::Icon;
use crate::ui::button::{self, Button, Size, Variant};
use crate::ui::context::Ds;
use crate::ui::icon::{IconSize, icon};
use crate::ui::icon_button::IconButton;
use crate::ui::layout::Stack;
use crate::ui::tooltip::Tooltip;

type Select = Rc<dyn Fn(&mut Window, &mut App)>;

/// One action of the bar (`SelectionBarAction`).
pub struct SelectionBarAction {
    id: SharedString,
    label: SharedString,
    icon: Icon,
    on_select: Option<Select>,
    disabled_reason: Option<SharedString>,
}

impl SelectionBarAction {
    /// `label`: a verb, a few words ("Add to chat"); also the icon-only tooltip on narrow pages.
    /// `icon` is drawn at the small icon size.
    pub fn new(id: impl Into<SharedString>, label: impl Into<SharedString>, icon: Icon) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            icon,
            on_select: None,
            disabled_reason: None,
        }
    }

    pub fn on_select(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_select = Some(Rc::new(handler));
        self
    }

    /// Shown but unavailable: the reason is its tooltip ("Pick an element first").
    pub fn unavailable(mut self, reason: impl Into<SharedString>) -> Self {
        self.disabled_reason = Some(reason.into());
        self
    }
}

impl SelectionBarAction {
    pub(super) fn disabled_reason(&self) -> Option<&SharedString> {
        self.disabled_reason.as_ref()
    }

    fn key(&self, bar: &ElementId) -> ElementId {
        (bar.clone(), self.id.clone()).into()
    }

    /// `WideAction`: an `xs` ghost button with its words; unavailable it stays focusable
    /// (`aria-disabled`) and its reason is the tooltip.
    pub(super) fn wide(
        &self,
        bar: &ElementId,
        reason: Option<SharedString>,
        ds: &Ds,
    ) -> AnyElement {
        let button = Button::new(self.key(bar))
            .size(Size::Xs)
            .variant(Variant::Ghost)
            .icon_start(icon(self.icon, IconSize::Sm, ds))
            .text(self.label.clone());
        match reason {
            Some(reason) => Tooltip::new((self.key(bar), "tooltip"))
                .label(reason)
                .child(button.aria_disabled())
                .into_any_element(),
            None => match self.on_select.clone() {
                Some(select) => button
                    .on_click(move |_, window, cx| select(window, cx))
                    .into_any_element(),
                None => button.into_any_element(),
            },
        }
    }

    /// `NarrowAction`: an icon button named by the label; an unavailable one reads
    /// `label · reason`.
    pub(super) fn narrow(
        &self,
        bar: &ElementId,
        reason: Option<SharedString>,
        ds: &Ds,
    ) -> AnyElement {
        let glyph = icon(self.icon, IconSize::Sm, ds);
        match reason {
            Some(reason) => IconButton::new(self.key(bar), format!("{} · {reason}", self.label))
                .icon(glyph)
                .disabled()
                .into_any_element(),
            None => {
                let button = IconButton::new(self.key(bar), self.label.clone()).icon(glyph);
                match self.on_select.clone() {
                    Some(select) => button
                        .on_click(move |_, window, cx| select(window, cx))
                        .into_any_element(),
                    None => button.into_any_element(),
                }
            }
        }
    }
}

/// `ButtonContainer` of the wide (`xs`) or narrow (`icon-sm`) actions, which never wrap here.
pub(super) fn row(wide: bool) -> Stack {
    button::container(if wide { Size::Xs } else { Size::IconSm }).wrap(false)
}
