//! DS ContextDonutButton (ContextDonutButton.tsx / ContextDonutButton.module.css): a 30px round
//! button around the 18px context ring, filled with the selection colour while hovered or open.
use std::rc::Rc;

use gpui::{App, ClickEvent, ElementId, IntoElement, RenderOnce, Window};

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::control::{Blend, Control, DisabledLook, Width};
use crate::ui::progress_ring::{ProgressRing, Size};

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct ContextDonutButton {
    id: ElementId,
    ratio: f32,
    expanded: bool,
    disabled: bool,
    on_click: Option<Handler>,
}

impl ContextDonutButton {
    /// `ratio` is the share of the context used, 0 to 1 (clamped).
    pub fn new(id: impl Into<ElementId>, ratio: f32) -> Self {
        Self {
            id: id.into(),
            ratio: ratio.clamp(0., 1.),
            expanded: false,
            disabled: false,
            on_click: None,
        }
    }

    /// `aria-expanded`: the details are open, so the button keeps its fill.
    pub fn expanded(mut self, expanded: bool) -> Self {
        self.expanded = expanded;
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

impl RenderOnce for ContextDonutButton {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let selection = ds.color(Color::Selection);
        let mut control = Control::new(self.id.clone(), ds);
        control.width = Width::Fixed(30.); // DS: ContextDonutButton.module.css:4
        control.height = Some(gpui::px(30.));
        control.radius = ds.len(Length::RadiusPill);
        control.scale = false;
        control.fill = if self.expanded {
            Blend::flat(selection)
        } else {
            Blend::hover(gpui::transparent_black(), selection)
        };
        control.fg = Blend::flat(ds.color(Color::TextPrimary));
        control.disabled_look = DisabledLook::Opacity(0.48);
        control.not_allowed = true;
        if self.disabled {
            control.disabled = crate::ui::control::Disabled::Native;
        }
        control.on_click(self.on_click);
        control.children = vec![
            ProgressRing::new((self.id, "ring"))
                .value(self.ratio)
                .size(Size::Donut)
                .into_any_element(),
        ];
        control
    }
}
