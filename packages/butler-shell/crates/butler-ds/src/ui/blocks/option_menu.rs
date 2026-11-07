//! DS OptionMenu (OptionMenu.tsx / OptionMenu.module.css): the chooser a composer popover holds
//! (the "+" add menu, the access mode): a visually hidden title, titled sections and rows with an
//! icon, a label and an inline or block description. Only the icon follows a row's tone; the
//! label stays primary text.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, IntoElement, ParentElement, RenderOnce, SharedString,
    Styled as _, Window, div, px,
};

use crate::tokens::{Color, Length, Number};
use crate::ui::blocks::composer_control::PermissionTone;
use crate::ui::button::{Button, Variant};
use crate::ui::context::Ds;
use crate::ui::control::{Blend, Disabled};
use crate::ui::tooltip::{Align, Side, Tooltip};

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// `size`: the default minimum width, or as wide as the widest row.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MenuFit {
    #[default]
    Default,
    Fit,
}

/// `tone`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ItemTone {
    #[default]
    Default,
    Accent,
    Warning,
    Muted,
}

/// `descriptionPlacement`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Placement {
    /// After the label, on its line.
    #[default]
    Inline,
    /// Under the label.
    Block,
}

#[derive(IntoElement)]
pub struct OptionMenu {
    fit: MenuFit,
    children: Vec<AnyElement>,
}

impl OptionMenu {
    /// The title is the menu's accessible name; it draws nothing.
    pub fn new(_title: impl Into<SharedString>) -> Self {
        Self {
            fit: MenuFit::Default,
            children: Vec::new(),
        }
    }

    pub fn fit(mut self) -> Self {
        self.fit = MenuFit::Fit;
        self
    }
}

impl ParentElement for OptionMenu {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for OptionMenu {
    fn render(self, window: &mut Window, _: &mut App) -> impl IntoElement {
        let menu = div().flex().flex_col().gap(px(2.));
        match self.fit {
            // `min-width: min(320px, calc(100vw - 32px))`
            MenuFit::Default => menu.min_w(px(
                320_f32.min(f32::from(window.viewport_size().width) - 32.)
            )),
            MenuFit::Fit => menu.max_w(window.viewport_size().width - px(32.)),
        }
        .children(self.children)
    }
}

/// `OptionMenuSection`: a group label over its rows.
#[derive(IntoElement)]
pub struct OptionMenuSection {
    title: SharedString,
    first: bool,
    children: Vec<AnyElement>,
}

impl OptionMenuSection {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            first: false,
            children: Vec::new(),
        }
    }

    /// The first section of a menu: its title has `--space-xs` of top padding. A section after
    /// another has `--space-1` of margin above it.
    pub fn first(mut self) -> Self {
        self.first = true;
        self
    }
}

impl ParentElement for OptionMenuSection {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for OptionMenuSection {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let top = if self.first {
            ds.len(Length::SpaceXs)
        } else {
            ds.len(Length::SpaceSm)
        };
        let mut section = div().flex().flex_col().gap(px(2.)).min_w_0();
        if !self.first {
            section = section.mt(ds.len(Length::Space1));
        }
        section
            .child(
                div()
                    .min_w_0()
                    .pt(top)
                    .px(ds.len(Length::SpaceSm))
                    .pb(ds.len(Length::SpaceXs))
                    .text_color(ds.color(Color::MenuGroupLabelColor))
                    .text_size(ds.len(Length::MenuGroupLabelSize))
                    .line_height(ds.len(Length::MenuGroupLabelLineHeight))
                    .font_weight(gpui::FontWeight(ds.number(Number::MenuGroupLabelWeight)))
                    .child(self.title),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .min_w_0()
                    .children(self.children),
            )
    }
}

#[derive(IntoElement)]
pub struct OptionMenuItem {
    id: ElementId,
    icon: Option<AnyElement>,
    label: SharedString,
    description: Option<AnyElement>,
    placement: Placement,
    selected: bool,
    tone: ItemTone,
    permission: Option<PermissionTone>,
    disabled: bool,
    reason: Option<(SharedString, Side, Align)>,
    on_click: Option<Handler>,
}

impl OptionMenuItem {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            icon: None,
            label: label.into(),
            description: None,
            placement: Placement::Inline,
            selected: false,
            tone: ItemTone::Default,
            permission: None,
            disabled: false,
            reason: None,
            on_click: None,
        }
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    pub fn description(mut self, description: impl IntoElement) -> Self {
        self.description = Some(description.into_any_element());
        self
    }

    pub fn block_description(mut self) -> Self {
        self.placement = Placement::Block;
        self
    }

    pub fn selected(mut self) -> Self {
        self.selected = true;
        self
    }

    pub fn tone(mut self, tone: ItemTone) -> Self {
        self.tone = tone;
        self
    }

    pub fn permission_tone(mut self, tone: PermissionTone) -> Self {
        self.permission = Some(tone);
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    /// Disables the item and names why in a short tooltip; the item stays hoverable.
    pub fn disabled_reason(mut self, reason: impl Into<SharedString>) -> Self {
        self.reason = Some((reason.into(), Side::Top, Align::Center));
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

impl OptionMenuItem {
    /// The icon's colour: the tone's, the access mode's, or the disabled text.
    fn icon_color(&self, ds: &Ds, blocked: bool) -> gpui::Hsla {
        if blocked {
            return ds.color(Color::InteractiveDisabledFg);
        }
        if let Some(permission) = self.permission {
            return ds.color(permission.icon());
        }
        ds.color(match self.tone {
            ItemTone::Default => Color::TextPrimary,
            ItemTone::Accent => Color::AccentText,
            ItemTone::Warning => Color::AccessFull,
            ItemTone::Muted => Color::TextSecondary,
        })
    }

    fn copy(&mut self, ds: &Ds) -> AnyElement {
        let label = div()
            .min_w_0()
            .overflow_hidden()
            .whitespace_nowrap()
            .text_ellipsis()
            .text_color(ds.color(Color::TextPrimary))
            .text_size(ds.len(Length::FontSize3))
            .line_height(ds.len(Length::MenuItemLineHeight))
            .child(self.label.clone());
        let description = self.description.take().map(|description| {
            let text = div()
                .text_color(ds.color(Color::TextSecondary))
                .text_size(ds.len(Length::FontSize2))
                .line_height(ds.len(Length::MenuItemLineHeight))
                .min_h(ds.len(Length::MenuItemLineHeight));
            match self.placement {
                Placement::Inline => text.flex().items_center().flex_none().child(description),
                Placement::Block => text
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .child(description),
            }
        });
        match self.placement {
            Placement::Inline => div()
                .flex()
                .items_center()
                .min_w_0()
                .gap(ds.len(Length::Space1))
                .child(label)
                .children(description),
            Placement::Block => div()
                .flex()
                .flex_col()
                .min_w_0()
                .child(label)
                .children(description),
        }
        .into_any_element()
    }
}

impl RenderOnce for OptionMenuItem {
    fn render(mut self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let blocked = self.reason.is_some();
        let line = ds.len(Length::MenuItemLineHeight);
        let icon = self.icon.take().map(|icon| {
            div()
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(line)
                .text_color(self.icon_color(ds, blocked))
                .child(icon)
        });
        let described = self.description.is_some();
        let copy = self.copy(ds);
        let mut button = Button::new(self.id.clone()).variant(Variant::Ghost);
        if self.disabled {
            button = button.disabled();
        }
        let mut control = button.control(ds);
        control.disabled = if blocked {
            Disabled::Aria
        } else if self.disabled {
            Disabled::Native
        } else {
            control.disabled
        };
        let selection = ds.color(Color::Selection);
        control.fill = if self.selected {
            Blend::flat(selection)
        } else {
            Blend::hover(gpui::transparent_black(), selection)
        };
        control.fg = Blend::flat(ds.color(Color::TextPrimary));
        control.scale = false;
        control.inline = false;
        control.justify_center = false;
        control.width = crate::ui::control::Width::Full;
        control.height = None;
        control.min_height = Some(ds.menu_item_height());
        control.padding = [
            ds.len(Length::Space2),
            ds.len(Length::MenuItemPaddingBlock),
            ds.len(Length::Space2),
            ds.len(Length::MenuItemPaddingBlock),
        ];
        control.gap = ds.len(Length::Space1);
        control.radius = ds.len(Length::RadiusControl);
        control.text_size = ds.len(Length::FontSize3);
        control.line_height = Some(line);
        control.not_allowed = blocked;
        control.on_click(if blocked { None } else { self.on_click });
        let row = div().flex().w_full().min_w_0().gap(ds.len(Length::Space1));
        // Two-line items keep the icon on the label line.
        let row = if self.placement == Placement::Block && described {
            row.items_start()
        } else {
            row.items_center()
        };
        control.children = vec![row.children(icon).child(copy).into_any_element()];
        match self.reason {
            Some((reason, side, align)) => Tooltip::new((self.id, "reason"))
                .label(reason)
                .side(side)
                .align(align)
                .child(control)
                .into_any_element(),
            None => control.into_any_element(),
        }
    }
}
