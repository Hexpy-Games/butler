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

/// What the content starts with: a row (NavRow, default) or a caption line (a date); the marker
/// centres on that first line.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub enum Lead {
    #[default]
    Row,
    Caption,
}

/// Events, newest first.
#[derive(IntoElement, Default)]
pub struct EventTimeline {
    items: Vec<EventTimelineItem>,
    lead: Lead,
}

impl EventTimeline {
    pub fn new() -> Self {
        Self::default()
    }

    /// What the content starts with: a row (NavRow, default) or a caption line (a date); the
    /// marker centres on that first line.
    pub fn lead(mut self, lead: Lead) -> Self {
        self.lead = lead;
        self
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
        let caption = ds.len(Length::TypoCaptionLineHeight);
        let (marker_top, connector_top) = match self.lead {
            Lead::Row => (gap, ds.len(Length::Space3xl)),
            Lead::Caption => (
                (caption - ds.len(Length::IconSizeSm)) / 2.,
                caption + ds.len(Length::SpaceXs),
            ),
        };
        let events = self.items.into_iter().enumerate().map(|(index, item)| {
            let connector = (index + 1 < count).then(|| {
                div()
                    .absolute()
                    .left(gap - edge)
                    .top(connector_top)
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
                        .pt(marker_top)
                        .text_color(ds.color(Color::TextTertiary))
                        .child(item.marker),
                )
                .child(div().flex_1().min_w_0().child(item.content))
        });
        div().flex().flex_col().gap(gap).children(events)
    }
}
