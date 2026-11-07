//! CollapsibleNavGroup.showcase.tsx: space folders, nested folders and a project group with
//! actions, in the app's SidebarShell. Every group is sticky (`stickyDepth`): each sidebar
//! records its scroller's top edge for the headers to hold at.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::collapsible_nav_group::{CollapsibleNavGroup, StickyScroll};
use butler_ds::ui::blocks::nav_row::{NavRow, NavRowSwap};
use butler_ds::ui::blocks::sidebar_shell::SidebarShell;
use butler_ds::ui::layout::{Space, Stack};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window};

use super::nav_parts::{action_button, flag, icon_cluster, row_menu};
use super::{Story, probe};
use crate::copy::Lang;

struct Copy {
    folder: &'static str,
    sessions: [&'static str; 3],
    project: &'static str,
    project_sessions: [&'static str; 2],
    dashboard: &'static str,
    closed: &'static str,
    closed_items: [&'static str; 1],
    menu: &'static str,
    rename: &'static str,
    archive: &'static str,
    expand: &'static str,
    collapse: &'static str,
    unread: &'static str,
    nested_project: &'static str,
    backlog: &'static str,
    backlog_items: [&'static str; 1],
    milestone: &'static str,
    milestone_items: [&'static str; 2],
    next: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            folder: "Design system",
            sessions: ["Token pages", "Motion trace", "Settings S7"],
            project: "butler",
            project_sessions: ["Release checklist review", "Queued messages"],
            dashboard: "Dashboard",
            closed: "Archive",
            closed_items: ["Old notes"],
            menu: "Row actions",
            rename: "Rename",
            archive: "Archive",
            expand: "Expand",
            collapse: "Collapse",
            unread: "Unread",
            nested_project: "Sweet potato game",
            backlog: "Backlog",
            backlog_items: ["Sound pass"],
            milestone: "Build a prototype",
            milestone_items: ["Pick the game direction", "Bunny escape controls test"],
            next: "Playtest notes",
        },
        Copy {
            folder: "디자인 시스템",
            sessions: ["토큰 페이지", "모션 추적", "설정 S7"],
            project: "butler",
            project_sessions: ["릴리스 체크리스트 검토", "대기 메시지"],
            dashboard: "대시보드",
            closed: "보관함",
            closed_items: ["이전 메모"],
            menu: "행 작업",
            rename: "이름 바꾸기",
            archive: "보관",
            expand: "펼치기",
            collapse: "접기",
            unread: "읽지 않음",
            nested_project: "고구마 게임",
            backlog: "백로그",
            backlog_items: ["사운드 다듬기"],
            milestone: "프로토타입 만들기",
            milestone_items: ["게임 방향 정하기", "바니 탈출 조작감 시제품"],
            next: "플레이 테스트 메모",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Space folders (indented)",
            render: space_folders,
        },
        Story {
            name: "Nested folders (indented)",
            render: nested_folders,
        },
        Story {
            name: "Project group with actions",
            render: project_group,
        },
    ]
}

/// `Sidebar`: the app's SidebarShell, with the recorder the sticky headers read the scroller's
/// top edge from as its first row.
fn sidebar(
    id: &'static str,
    scroll: &StickyScroll,
    rows: impl IntoIterator<Item = AnyElement>,
) -> AnyElement {
    let mut shell = SidebarShell::new(id)
        .scroll_fade(false)
        .child(scroll.recorder());
    for row in rows {
        shell = shell.child(row);
    }
    shell.into_any_element()
}

fn row_menu_of(id: &str, c: &Copy) -> AnyElement {
    row_menu(
        SharedString::from(id.to_owned()),
        None,
        false,
        (c.menu, c.rename, c.archive, c.unread),
    )
}

/// `FolderActions`: an optional dashboard button, then the disclosure chevron that gives way
/// to the row menu.
fn folder_actions(
    id: &str,
    c: &Copy,
    (title, expanded): (&str, bool),
    dashboard: bool,
    toggle: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let chevron = action_button(
        SharedString::from(format!("{id}-chevron")),
        format!("{title} {}", if expanded { c.collapse } else { c.expand }),
        if expanded {
            Icon::ChevronDown
        } else {
            Icon::ChevronRight
        },
    )
    .on_click(toggle)
    .into_any_element();
    let swap = NavRowSwap::new(
        SharedString::from(format!("{id}-swap")),
        row_menu_of(&format!("{id}-menu"), c),
    )
    .rest(chevron)
    .into_any_element();
    let mut buttons = Vec::new();
    if dashboard {
        buttons.push(
            action_button(
                SharedString::from(format!("{id}-dashboard")),
                format!("{title} {}", c.dashboard),
                Icon::LayoutDashboard,
            )
            .into_any_element(),
        );
    }
    buttons.push(swap);
    icon_cluster(buttons).into_any_element()
}

fn session_row(id: String, label: &'static str, c: &Copy, active: bool, click: bool) -> NavRow {
    let menu = row_menu_of(&format!("{id}-menu"), c);
    let row = NavRow::new(SharedString::from(id), label)
        .glyph(Icon::Notebook)
        .actions(menu);
    let row = if active { row.active() } else { row };
    if click {
        row.on_click(|_, _, _| {})
    } else {
        row
    }
}

fn space_folders(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let (expanded, toggle) = flag("cng-space-open", true, window, cx);
    let (closed, toggle_closed) = flag("cng-space-closed", false, window, cx);
    let scroll = StickyScroll::new("cng-space-scroll", window, cx);
    let mut open = CollapsibleNavGroup::new("cng-space", c.folder, expanded)
        .indented()
        .sticky(&scroll, 0)
        .glyph(if expanded {
            Icon::FolderOpen
        } else {
            Icon::Folder
        })
        .on_toggle(toggle.clone())
        .actions(folder_actions(
            "cng-space-actions",
            &c,
            (c.folder, expanded),
            false,
            toggle,
        ));
    for (index, session) in c.sessions.iter().enumerate() {
        open = open.child(session_row(
            format!("cng-space-s{index}"),
            session,
            &c,
            index == 1,
            true,
        ));
    }
    let mut shut = CollapsibleNavGroup::new("cng-closed", c.closed, closed)
        .indented()
        .sticky(&scroll, 0)
        .glyph(Icon::Folder)
        .on_toggle(toggle_closed.clone())
        .actions(folder_actions(
            "cng-closed-actions",
            &c,
            (c.closed, closed),
            false,
            toggle_closed,
        ));
    for item in c.closed_items {
        shut = shut.child(session_row(
            format!("cng-closed-{item}"),
            item,
            &c,
            false,
            false,
        ));
    }
    let body = Stack::new().gap(Space::Xs).child(open).child(shut);
    sidebar(
        "cng-space-sidebar",
        &scroll,
        [
            body.into_any_element(),
            probe(format!("cng-space-open-{expanded}")).into_any_element(),
        ],
    )
}

fn project_group(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let (expanded, toggle) = flag("cng-project-open", true, window, cx);
    let scroll = StickyScroll::new("cng-project-scroll", window, cx);
    let mut group = CollapsibleNavGroup::new("cng-project", c.project, expanded)
        .indented()
        .sticky(&scroll, 0)
        .glyph(if expanded {
            Icon::FolderOpen
        } else {
            Icon::Folder
        })
        .on_toggle(toggle.clone())
        .actions(folder_actions(
            "cng-project-actions",
            &c,
            (c.project, expanded),
            true,
            toggle,
        ));
    for (index, session) in c.project_sessions.iter().enumerate() {
        group = group.child(session_row(
            format!("cng-project-s{index}"),
            session,
            &c,
            false,
            true,
        ));
    }
    sidebar("cng-project-sidebar", &scroll, [group.into_any_element()])
}

fn nested_folders(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let (project, toggle_project) = flag("cng-n-project", true, window, cx);
    let (backlog, toggle_backlog) = flag("cng-n-backlog", false, window, cx);
    let (milestone, toggle_milestone) = flag("cng-n-milestone", true, window, cx);
    let (closed, toggle_closed) = flag("cng-n-closed", false, window, cx);
    let scroll = StickyScroll::new("cng-n-scroll", window, cx);
    let folder = |id: &'static str, label: &'static str, depth: usize, open: bool, toggle: _| {
        CollapsibleNavGroup::new(id, label, open)
            .indented()
            .sticky(&scroll, depth)
            .glyph(if open { Icon::FolderOpen } else { Icon::Folder })
            .on_toggle(toggle)
    };
    let rows = |prefix: &str, items: &[&'static str]| -> Vec<AnyElement> {
        items
            .iter()
            .map(|item| {
                NavRow::new(SharedString::from(format!("{prefix}-{item}")), *item)
                    .glyph(Icon::Notebook)
                    .on_click(|_, _, _| {})
                    .into_any_element()
            })
            .collect()
    };
    let mut backlog_group = folder("cng-n-backlog-g", c.backlog, 1, backlog, toggle_backlog);
    for row in rows("cng-n-b", &c.backlog_items) {
        backlog_group = backlog_group.child(row);
    }
    let mut milestone_group = folder(
        "cng-n-milestone-g",
        c.milestone,
        1,
        milestone,
        toggle_milestone,
    );
    for row in rows("cng-n-m", &c.milestone_items) {
        milestone_group = milestone_group.child(row);
    }
    let mut outer = folder(
        "cng-n-project-g",
        c.nested_project,
        0,
        project,
        toggle_project,
    )
    .child(backlog_group)
    .child(milestone_group);
    for row in rows("cng-n-next", &[c.next]) {
        outer = outer.child(row);
    }
    let mut closed_group = folder("cng-n-closed-g", c.closed, 0, closed, toggle_closed);
    for row in rows("cng-n-c", &c.closed_items) {
        closed_group = closed_group.child(row);
    }
    let body = Stack::new().gap(Space::Xs).child(outer).child(closed_group);
    sidebar("cng-nested-sidebar", &scroll, [body.into_any_element()])
}
