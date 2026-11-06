//! DS EventTimeline (EventTimeline.tsx / EventTimeline.module.css): a vertical run of dated
//! events. A marker column (one `--space-2xl` icon slot) sits beside the event content, and a
//! hairline joins each marker to the next event.
use gpui::{AnyElement, App, IntoElement, ParentElement, RenderOnce, Styled as _, Window, div};

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;

/// One event: its kind icon and its content.
pub struct EventTimelineItem {
    marker: AnyElement,
    content: AnyElement,
}

impl EventTimelineItem {
    pub fn new(marker: impl IntoElement, content: impl IntoElement) -> Self {
        Self {
            marker: marker.into_any_element(),
            content: content.into_any_element(),
        }
    }
}

/// Events, newest first.
#[derive(IntoElement, Default)]
pub struct EventTimeline {
    items: Vec<EventTimelineItem>,
}

impl EventTimeline {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn item(mut self, item: EventTimelineItem) -> Self {
        self.items.push(item);
        self
    }
}

impl RenderOnce for EventTimeline {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let count = self.items.len();
        let (gap, slot, edge) = (
            ds.len(Length::SpaceMd),
            ds.len(Length::Space2xl),
            ds.len(Length::BorderHairline),
        );
        let events = self.items.into_iter().enumerate().map(|(index, item)| {
            let connector = (index + 1 < count).then(|| {
                div()
                    .absolute()
                    .left(gap - edge)
                    .top(ds.len(Length::Space3xl))
                    .bottom(-gap)
                    .w(edge)
                    .bg(ds.color(Color::Line))
            });
            div()
                .relative()
                .flex()
                .gap(ds.len(Length::SpaceSm))
                .children(connector)
                .child(
                    div()
                        .flex()
                        .flex_none()
                        .justify_center()
                        .w(slot)
                        .pt(gap)
                        .text_color(ds.color(Color::TextTertiary))
                        .child(item.marker),
                )
                .child(div().flex_1().min_w_0().child(item.content))
        });
        div().flex().flex_col().gap(gap).children(events)
    }
}
