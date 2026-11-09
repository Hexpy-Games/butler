//! DS ActivityStrip (ActivityStrip.tsx / ActivityStrip.module.css): one thin cell per day, filled
//! on the days something changed. The day's label is its tooltip (React's `title`).
use gpui::{
    ElementId, InteractiveElement as _, IntoElement, ParentElement as _, RenderOnce, SharedString,
    Styled as _, Window, div, px,
};

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::tooltip::Tooltip;

/// The gap between cells (DS: ActivityStrip.module.css:2).
const GAP: f32 = 2.;

/// One day of the strip.
#[derive(Clone, Debug)]
pub struct ActivityStripDay {
    pub key: SharedString,
    /// The tooltip of the day (a localized date).
    pub label: SharedString,
    pub active: bool,
}

impl ActivityStripDay {
    pub fn new(key: impl Into<SharedString>, label: impl Into<SharedString>, active: bool) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            active,
        }
    }
}

#[derive(IntoElement)]
pub struct ActivityStrip {
    id: ElementId,
    days: Vec<ActivityStripDay>,
    aria_label: SharedString,
}

impl ActivityStrip {
    /// `aria_label` is the spoken summary, e.g. the active dates (gpui draws none of it).
    pub fn new(
        id: impl Into<ElementId>,
        days: Vec<ActivityStripDay>,
        aria_label: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            days,
            aria_label: aria_label.into(),
        }
    }

    /// The accessible name of the strip.
    pub fn aria_label(&self) -> &SharedString {
        &self.aria_label
    }
}

impl RenderOnce for ActivityStrip {
    fn render(self, _: &mut Window, cx: &mut gpui::App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let (idle, active) = (ds.color(Color::Line), ds.color(Color::ContextChart1));
        let base = SharedString::from(self.id.to_string());
        let cells = self.days.into_iter().enumerate().map(|(index, day)| {
            let fill = if day.active { active } else { idle };
            Tooltip::new((base.clone(), index))
                .fill()
                .label(day.label)
                .child(div().flex_1().min_w_0().bg(fill))
        });
        div()
            .id(self.id)
            .flex()
            .w_full()
            .h(ds.len(Length::SpaceSm))
            .gap(px(GAP))
            .children(cells)
    }
}
