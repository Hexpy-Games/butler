//! OverflowActionMenu.showcase.tsx: the session actions, the menu in a sidebar row (it replaces
//! the row's rest status on hover or focus) and the text-only items of the Space header.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::nav_row::NavRow;
use butler_ds::ui::blocks::overflow_action_menu::{OverflowActionMenu, OverflowItem};
use gpui::{AnyElement, App, IntoElement as _, Window};

use super::Story;
use super::nav_parts::sidebar;
use crate::copy::Lang;

struct Copy {
    session: &'static str,
    space: &'static str,
    rename: &'static str,
    pin: &'static str,
    archive: &'static str,
    remove: &'static str,
    new_project: &'static str,
    new_group: &'static str,
    row: &'static str,
    unread: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            session: "Session actions",
            space: "Space menu",
            rename: "Rename",
            pin: "Pin",
            archive: "Archive",
            remove: "Delete",
            new_project: "New project",
            new_group: "New group",
            row: "Release checklist review",
            unread: "Unread",
        },
        Copy {
            session: "세션 작업",
            space: "스페이스 메뉴",
            rename: "이름 바꾸기",
            pin: "고정",
            archive: "보관",
            remove: "삭제",
            new_project: "새 프로젝트",
            new_group: "새 그룹",
            row: "릴리스 체크리스트 검토",
            unread: "읽지 않음",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Session actions",
            render: session,
        },
        Story {
            name: "In a sidebar row",
            render: in_row,
        },
        Story {
            name: "Text-only items (Space header)",
            render: text_only,
        },
    ]
}

fn session_items(id: &'static str, c: &Copy) -> OverflowActionMenu {
    OverflowActionMenu::new(id, c.session)
        .item(OverflowItem::new(c.rename).icon(Icon::PencilLine))
        .item(OverflowItem::new(c.pin).icon(Icon::Pin))
        .item(OverflowItem::new(c.archive).icon(Icon::Archive))
        .item(OverflowItem::new(c.remove).icon(Icon::Trash2).destructive())
}

fn session(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    session_items("oam-session", &copy(lang)).into_any_element()
}

fn in_row(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    // The row's own menu has the four session actions.
    let menu = session_items("oam-row-menu", &c);
    let swap = butler_ds::ui::blocks::nav_row::NavRowSwap::new("oam-row-swap", menu)
        .rest(butler_ds::ui::unread_dot::UnreadDot::new("oam-row-unread", c.unread).present(false));
    sidebar(
        "oam-row-sidebar",
        [NavRow::new("oam-row", c.row)
            .glyph(Icon::Folder)
            .on_click(|_, _, _| {})
            .actions(swap)
            .into_any_element()],
    )
}

fn text_only(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    OverflowActionMenu::new("oam-space", c.space)
        .item(OverflowItem::new(c.new_project))
        .item(OverflowItem::new(c.new_group))
        .into_any_element()
}
