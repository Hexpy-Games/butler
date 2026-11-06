//! BottomSheetItem (BottomSheet.tsx, BottomSheet.module.css `.item`): one touch-sized row.
use std::cell::Cell;
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, IntoElement, ParentElement as _, RenderOnce,
    SharedString, Styled as _, Window, div, px,
};

use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::context::{Ds, SHEET_ROW_HEIGHT};
use crate::ui::control::{Blend, Control, Disabled, DisabledLook, Width};
use crate::ui::focus;
use crate::ui::icon::{IconSize, icon};

/// `variant`: a destructive row is in `--danger`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Variant {
    #[default]
    Default,
    Destructive,
}

/// The event `on_select` handlers get: `prevent_default` keeps the sheet open.
#[derive(Default)]
pub struct SelectEvent {
    prevented: Cell<bool>,
}

impl SelectEvent {
    pub fn prevent_default(&self) {
        self.prevented.set(true);
    }
}

type Handler = Rc<dyn Fn(&SelectEvent, &mut Window, &mut App)>;
/// Closes the sheet an item is in.
pub(super) type Close = Rc<dyn Fn(&mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct BottomSheetItem {
    id: ElementId,
    label: SharedString,
    icon: Option<Icon>,
    selected: bool,
    variant: Variant,
    disabled: bool,
    on_select: Option<Handler>,
    /// Closes the sheet; given by the sheet the item is put in.
    close: Option<Close>,
}

impl BottomSheetItem {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            icon: None,
            selected: false,
            variant: Variant::Default,
            disabled: false,
            on_select: None,
            close: None,
        }
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    /// Shows a check; the row is the current choice (`aria-current`).
    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    pub fn variant(mut self, variant: Variant) -> Self {
        self.variant = variant;
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    /// Runs on activation, then the sheet closes unless the handler prevents it.
    pub fn on_select(
        mut self,
        handler: impl Fn(&SelectEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_select = Some(Rc::new(handler));
        self
    }

    pub(super) fn closing(mut self, close: Close) -> Self {
        self.close = Some(close);
        self
    }
}

impl RenderOnce for BottomSheetItem {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let focus_handle = window
            .use_keyed_state((self.id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
            .read(cx)
            .clone();
        let ds = Ds::get(cx);
        let selection = ds.color(Color::Selection);
        let focused = focus::visible(ds, focus_handle.is_focused(window), false) && !self.disabled;
        let mut control = Control::new(self.id.clone(), ds);
        control.width = Width::Full;
        control.inline = false;
        control.justify_center = false;
        control.scale = false;
        control.radius = ds.len(Length::RadiusControl);
        control.min_height = Some(px(SHEET_ROW_HEIGHT));
        control.gap = ds.len(Length::Space3);
        let side = ds.len(Length::Space3);
        control.padding = [side, px(0.), side, px(0.)];
        // `font: inherit` of the page body.
        control.text_size = ds.len(Length::TypoBodySize);
        control.line_height = Some(ds.len(Length::TypoBodyLineHeight));
        control.fill = Blend::hover(
            if focused {
                selection
            } else {
                gpui::transparent_black()
            },
            selection,
        );
        control.fg = Blend::flat(ds.color(match self.variant {
            Variant::Default => Color::TextPrimary,
            Variant::Destructive => Color::Danger,
        }));
        control.disabled = if self.disabled {
            Disabled::Native
        } else {
            Disabled::No
        };
        control.disabled_look = DisabledLook::Text;
        control.focus = Some(focus_handle);
        control.children = self.children(ds);
        let (select, close) = (self.on_select.clone(), self.close.clone());
        control.on_click(Some(Rc::new(move |_: &ClickEvent, window, cx| {
            let event = SelectEvent::default();
            if let Some(select) = &select {
                select(&event, window, cx);
            }
            if let (false, Some(close)) = (event.prevented.get(), &close) {
                close(window, cx);
            }
        })));
        control
    }
}

impl BottomSheetItem {
    /// The icon, the label (it takes the room that is left) and the check.
    fn children(&self, ds: &Ds) -> Vec<AnyElement> {
        let mut children = Vec::new();
        if let Some(glyph) = self.icon {
            children.push(
                div()
                    .flex()
                    .flex_none()
                    .text_color(ds.color(Color::TextSecondary))
                    .child(icon(glyph, IconSize::Md, ds))
                    .into_any_element(),
            );
        }
        children.push(
            div()
                .min_w_0()
                .flex_auto()
                .child(self.label.clone())
                .into_any_element(),
        );
        if self.selected {
            children.push(
                div()
                    .flex()
                    .flex_none()
                    .text_color(ds.color(Color::AccentText))
                    .child(icon(Icon::CheckIcon, IconSize::Md, ds))
                    .into_any_element(),
            );
        }
        children
    }
}
