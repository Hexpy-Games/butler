//! `LibraryKindView`'s selection: cards picked with the circle, ⌘/Ctrl-click, or a Shift-click
//! range from the last pick. It resets with the level and the filters (`scope`).
use gpui::Context;

use crate::ui::manage::library::LibraryPage;
use crate::ui::manage::library::types::LibraryItem;

#[derive(Default)]
pub(crate) struct Selection {
    /// `[kind, group, filters]`: the selection belongs to one list.
    pub(crate) scope: String,
    pub(crate) ids: Vec<String>,
    pub(crate) anchor: Option<String>,
}

impl LibraryPage {
    /// `select`: one card, or with Shift the range from the anchor to it.
    pub(crate) fn select(
        &mut self,
        item: &LibraryItem,
        on: bool,
        shift: bool,
        cx: &mut Context<Self>,
    ) {
        let rows = &self.list.items;
        let anchor = self
            .selection
            .anchor
            .as_ref()
            .and_then(|id| rows.iter().position(|row| &row.id == id));
        let here = rows.iter().position(|row| row.id == item.id);
        let ids: Vec<String> = match (shift, anchor, here) {
            (true, Some(a), Some(b)) => rows[a.min(b)..=a.max(b)]
                .iter()
                .map(|row| row.id.clone())
                .collect(),
            _ => vec![item.id.clone()],
        };
        if on {
            for id in ids {
                if !self.selection.ids.contains(&id) {
                    self.selection.ids.push(id);
                }
            }
        } else {
            self.selection.ids.retain(|id| !ids.contains(id));
        }
        self.selection.anchor = Some(item.id.clone());
        cx.notify();
    }

    /// The picked cards that the list shows.
    pub(crate) fn selected_items(&self) -> Vec<LibraryItem> {
        self.list
            .items
            .iter()
            .filter(|item| self.selection.ids.contains(&item.id))
            .cloned()
            .collect()
    }

    /// The check at the left of the selection bar: all, or none when all are picked.
    pub(crate) fn toggle_all(&mut self, cx: &mut Context<Self>) {
        let all = self.selected_items().len() == self.list.items.len();
        self.selection.ids = if all {
            Vec::new()
        } else {
            self.list.items.iter().map(|item| item.id.clone()).collect()
        };
        cx.notify();
    }

    /// Cancel
    pub(crate) fn clear_selection(&mut self, cx: &mut Context<Self>) {
        self.selection.ids.clear();
        cx.notify();
    }
}
