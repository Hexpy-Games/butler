//! DS AutomationRunList (AutomationRunList.tsx): the runs of a 예약 작업 as an ActivityFeed, one
//! row per run (state icon, state label, age, and the reason when it failed).
use gpui::{App, ElementId, IntoElement, RenderOnce, SharedString, Window};

use super::activity_feed::{ActivityFeed, ActivityFeedItem};

#[derive(IntoElement)]
pub struct AutomationRunList {
    id: ElementId,
    runs: Vec<ActivityFeedItem>,
    title: SharedString,
    empty_label: SharedString,
}

impl AutomationRunList {
    pub fn new(id: impl Into<ElementId>, runs: Vec<ActivityFeedItem>) -> Self {
        Self {
            id: id.into(),
            runs,
            title: "Runs".into(),
            empty_label: "No automation runs yet".into(),
        }
    }

    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = title.into();
        self
    }

    pub fn empty_label(mut self, label: impl Into<SharedString>) -> Self {
        self.empty_label = label.into();
        self
    }
}

impl RenderOnce for AutomationRunList {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        ActivityFeed::new(self.id, self.runs)
            .title(self.title)
            .empty_label(self.empty_label)
    }
}
