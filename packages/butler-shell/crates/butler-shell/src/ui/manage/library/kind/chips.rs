//! `library/GroupChips.tsx`: the groups (folders) of a kind as a row of chips above its cards.
//! A chip of a group takes dropped cards and chips of its kind like a tile ([`group_target`]).
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::overflow_action_menu::{OverflowActionMenu, OverflowItem};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Inline, Space};
use butler_ds::ui::pill_button::PillButton;
use gpui::{
    AnyElement, Context, Entity, InteractiveElement as _, IntoElement as _, ParentElement as _,
    SharedString, div,
};

use crate::ui::manage::library::LibraryPage;
use crate::ui::manage::library::detail::LibraryDialog;
use crate::ui::manage::library::main::copy::get;
use crate::ui::manage::library::main::tiles::group_target;
use crate::ui::manage::library::open_library;
use crate::ui::manage::library::types::{LibraryGroup, LibraryGroups};
use crate::ui::manage::{LibraryKind, LibraryView, ManageCtx};
use crate::ui::widgets::anchor;

/// One chip that opens a level of the kind.
fn chip(
    ctx: &ManageCtx,
    id: String,
    text: &str,
    count: i64,
    pressed: bool,
    group: Option<&str>,
    kind: LibraryKind,
) -> PillButton {
    let (ctx, group) = (
        ctx.clone(),
        group.map(|group| SharedString::from(group.to_owned())),
    );
    PillButton::new(SharedString::from(id))
        .text(text.to_owned())
        .count(count.to_string())
        .pressed(pressed)
        .on_click(move |_, _, cx| open_library(&ctx, Some(kind), group.clone(), cx))
}

impl LibraryPage {
    /// `GroupChips`
    pub(crate) fn group_chips(
        &self,
        kind: LibraryKind,
        view: &LibraryView,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = get(cx).groups(kind);
        let all = get(cx).all;
        let groups = self
            .groups
            .get(&kind)
            .and_then(|cell| cell.borrow().data.clone())
            .unwrap_or(LibraryGroups {
                groups: Vec::new(),
                ungrouped: 0,
                total: 0,
            });
        let selected = view.group.as_deref();
        let page = cx.entity();
        let mut row = Inline::new().gap(Space::Xs).child(chip(
            &self.ctx,
            "library-chip-all".to_owned(),
            all,
            groups.total,
            selected.is_none(),
            None,
            kind,
        ));
        for group in &groups.groups {
            let mut chip = chip(
                &self.ctx,
                format!("library-chip-{}", group.id),
                &group.name,
                group.count,
                selected == Some(group.id.as_str()),
                Some(&group.id),
                kind,
            );
            if self.drop_over(&group.id, cx) {
                chip = chip.drop_target();
            }
            row = row.child(
                group_target(&page, format!("library-chip-drop-{}", group.id), group).child(chip),
            );
        }
        row = row.child(chip(
            &self.ctx,
            "library-chip-none".to_owned(),
            words.ungrouped,
            groups.ungrouped,
            selected == Some("none"),
            Some("none"),
            kind,
        ));
        let plus = icon(Icon::Plus, IconSize::Sm, Ds::get(cx));
        let create = page.clone();
        row = row.child(
            PillButton::new("library-chip-new")
                .icon(plus)
                .text(words.new_group)
                .on_click(move |_, _, cx| {
                    create.update(cx, |_, cx| {
                        LibraryPage::dialog(LibraryDialog::CreateGroup { kind, then: None }, cx);
                    });
                }),
        );
        let current = groups
            .groups
            .iter()
            .find(|group| Some(group.id.as_str()) == selected);
        row = row.children(current.map(|group| group_menu(&page, group, cx)));
        anchor(div().id("library-group-chips"), "library-group-chips")
            .child(row)
            .into_any_element()
    }
}

/// The ⋯ menu of the chosen group: rename, and ungroup (the items stay).
fn group_menu(
    page: &Entity<LibraryPage>,
    group: &LibraryGroup,
    cx: &Context<LibraryPage>,
) -> AnyElement {
    let words = get(cx);
    let (rename, ungroup) = (page.clone(), page.clone());
    let (named, loose) = (group.clone(), group.clone());
    OverflowActionMenu::new("library-chip-menu", words.more)
        .item(
            OverflowItem::new(words.rename)
                .icon(Icon::PencilLine)
                .on_select(move |_, cx| {
                    let group = named.clone();
                    rename.update(cx, |_, cx| {
                        LibraryPage::dialog(LibraryDialog::RenameGroup(group), cx);
                    });
                }),
        )
        .item(
            OverflowItem::new(words.groups(group.kind).ungroup)
                .icon(Icon::X)
                .destructive()
                .on_select(move |_, cx| {
                    let group = loose.clone();
                    ungroup.update(cx, |_, cx| {
                        LibraryPage::dialog(LibraryDialog::Ungroup(group), cx);
                    });
                }),
        )
        .into_any_element()
}
