//! SpaceBrowseHeader: view tabs and new group/project menu.
use super::{Shell, Tab, dialogs::SpaceDialog};
use crate::ui::Icon;
use butler_ds::{
    tokens::Length,
    ui::{
        blocks::nav_section::NavSectionHeading,
        context::Ds,
        dropdown_menu::{DropdownMenu, DropdownMenuContent, Item},
        icon_button::IconButton,
        layout::{Space, Stack},
        segmented_control::{Choice, SegmentedControl},
    },
};
use gpui::{AnyElement, Context, Window, div, prelude::*};
impl Shell {
    pub(super) fn space_browse_header(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let strings = self.theme.strings;
        let weak = cx.entity().downgrade();
        let tabs = SegmentedControl::new("sidebar-tabs", strings.space, self.sidebar.tab.value())
            .stretch()
            .options([
                Choice::new("all", strings.all).icon(Icon::TableOfContents),
                Choice::new("recent", strings.recent).icon(Icon::Clock3),
                Choice::new("running", strings.running).icon(Icon::Activity),
            ])
            .on_value_change(move |value, _, cx| {
                let _ = weak.update(cx, |s, cx| {
                    s.sidebar.set_tab(value);
                    if s.sidebar.tab == Tab::Running {
                        s.store.navigation.work_status = None;
                        s.load_work_status(cx);
                    }
                    cx.notify();
                });
            });
        let mut top = div()
            .flex()
            .flex_col()
            .gap(Ds::get(cx).len(Length::SpaceMd))
            .child(crate::ui::widgets::anchor(div(), "sidebar-tabs").child(tabs));
        if self.sidebar.tab == Tab::All
            && let Some(row) = self.store.navigation.rows.get("s:general").cloned()
        {
            top = top.child(self.space_row(&row, false, true, "browse", cx));
        }
        let actions = self.browse_actions(window, cx);
        let title = match self.sidebar.tab {
            Tab::All => strings.space,
            Tab::Recent => strings.recent,
            Tab::Running => strings.running,
        };
        Stack::new()
            .gap(if self.sidebar.tab == Tab::All {
                Space::Sm
            } else {
                Space::Lg
            })
            .compact_gap(Space::Lg)
            .child(top)
            .child(NavSectionHeading::new(title).actions(actions))
            .into_any_element()
    }
    pub(super) fn browse_actions(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let menu = DropdownMenu::new("sidebar-create", window, cx);
        let trigger = menu.trigger(|toggle| {
            crate::ui::widgets::anchor(div(), "sidebar-create-trigger")
                .child(
                    IconButton::new(
                        "sidebar-create-trigger",
                        self.copy("Space menu", "공간 메뉴"),
                    )
                    .glyph(Icon::FolderPlus)
                    .on_click(toggle.on_click()),
                )
                .into_any_element()
        });
        let mut content = DropdownMenuContent::new();
        for (label, dialog) in [
            (self.copy("New group", "새 그룹"), SpaceDialog::Create(None)),
            (
                self.copy("New project", "새 프로젝트"),
                SpaceDialog::CreateProject,
            ),
        ] {
            let weak = cx.entity().downgrade();
            content = content.child(Item::new(label).on_select(move |_, cx| {
                let _ = weak.update(cx, |s, cx| {
                    s.sidebar.set_dialog(Some(dialog.clone()));
                    cx.notify();
                });
            }));
        }
        let count = self
            .store
            .navigation
            .view
            .as_ref()
            .map_or(0, |v| v.archive_count);
        let archive = if count > 0 {
            format!("{} ({count})", self.copy("Archive", "보관함"))
        } else {
            self.copy("Archive", "보관함").to_owned()
        };
        content = content.child(Item::new(archive).disabled());
        let content = menu.content(content, window, cx);
        div()
            .flex()
            .child(
                IconButton::new("browse-new-chat", self.theme.strings.new_chat)
                    .glyph(Icon::PencilLine)
                    .on_click(cx.listener(|s, _, w, cx| s.open_chat(None, w, cx))),
            )
            .child(trigger)
            .child(content)
            .into_any_element()
    }
}
