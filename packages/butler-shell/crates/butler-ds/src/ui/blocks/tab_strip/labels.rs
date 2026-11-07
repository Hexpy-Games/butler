//! The strip's copy (tabStripLabels.ts): English by default; the app container passes localized
//! labels. Only the copy gpui draws is here (the screen-reader strings have no gpui target).
use gpui::SharedString;

#[derive(Clone)]
pub struct TabStripLabels {
    /// The title of the `mine` group.
    pub my_tabs: SharedString,
    /// The row's new-tab button.
    pub new_tab: SharedString,
    pub close_tab: SharedString,
    /// A tab or group without a title.
    pub untitled: SharedString,
    pub working: SharedString,
    pub waiting: SharedString,
    pub crashed: SharedString,
    /// A group's own new-tab button ("New tab in {group}").
    pub new_tab_in: fn(&str) -> String,
    /// A folded group's count of tabs beyond its favicons ("+2").
    pub more_tabs: fn(usize) -> String,
}

impl Default for TabStripLabels {
    fn default() -> Self {
        Self {
            my_tabs: "My tabs".into(),
            new_tab: "New tab".into(),
            close_tab: "Close tab".into(),
            untitled: "Untitled".into(),
            working: "Butler is working".into(),
            waiting: "Waiting for approval".into(),
            crashed: "Page stopped".into(),
            new_tab_in: |group| format!("New tab in {group}"),
            more_tabs: |count| format!("+{count}"),
        }
    }
}

impl TabStripLabels {
    pub(super) fn group_label(&self, group: &super::model::Group) -> SharedString {
        match group.label.as_ref().map(|label| label.trim()) {
            Some(label) if !label.is_empty() => label.to_owned().into(),
            _ if group.is_mine() => self.my_tabs.clone(),
            _ => self.untitled.clone(),
        }
    }

    pub(super) fn tab_title(&self, tab: &super::model::Tab) -> SharedString {
        let title = tab.title.trim();
        if title.is_empty() {
            self.untitled.clone()
        } else {
            title.to_owned().into()
        }
    }

    pub(super) fn group_state(&self, state: super::model::GroupState) -> SharedString {
        use super::model::GroupState::{Crashed, Waiting, Working};
        match state {
            Working => self.working.clone(),
            Waiting => self.waiting.clone(),
            Crashed => self.crashed.clone(),
        }
    }
}
