//! DS BlockTabs (BlockTabs.tsx): content blocks split over line tabs; the first tab is open.
use gpui::{AnyElement, App, ElementId, IntoElement, RenderOnce, SharedString, Window};

use crate::ui::layout::Space;
use crate::ui::tabs::{ListVariant, Tabs, TabsList, Trigger};

/// One tab: a few words for its name, and its content blocks.
pub struct BlockTab {
    label: SharedString,
    content: AnyElement,
}

impl BlockTab {
    pub fn new(label: impl Into<SharedString>, content: impl IntoElement) -> Self {
        Self {
            label: label.into(),
            content: content.into_any_element(),
        }
    }
}

#[derive(IntoElement)]
pub struct BlockTabs {
    id: ElementId,
    aria_label: SharedString,
    tabs: Vec<BlockTab>,
}

impl BlockTabs {
    /// `aria_label` names the tab list when no visible title does.
    pub fn new(id: impl Into<ElementId>, aria_label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            aria_label: aria_label.into(),
            tabs: Vec::new(),
        }
    }

    pub fn tab(mut self, tab: BlockTab) -> Self {
        self.tabs.push(tab);
        self
    }
}

impl RenderOnce for BlockTabs {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let value = |index: usize| SharedString::from(index.to_string());
        let list = TabsList::new(self.aria_label)
            .variant(ListVariant::Line)
            .triggers(
                self.tabs
                    .iter()
                    .enumerate()
                    .map(|(index, tab)| Trigger::new(value(index), tab.label.clone())),
            );
        let mut tabs = Tabs::new(self.id)
            .gap(Space::Md)
            .default_value(value(0))
            .list(list);
        for (index, tab) in self.tabs.into_iter().enumerate() {
            tabs = tabs.panel(value(index), tab.content);
        }
        tabs
    }
}
