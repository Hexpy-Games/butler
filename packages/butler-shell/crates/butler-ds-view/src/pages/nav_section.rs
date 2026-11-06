//! NavSection.showcase.tsx: a titled section of rows with heading actions, a collapsed section,
//! and the heading alone over custom content (the Space sidebar's header).
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::nav_row::NavRow;
use butler_ds::ui::blocks::nav_section::{NavSection, NavSectionHeading};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dropdown_menu::{DropdownMenu, DropdownMenuContent, Item};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::overlay::place::Align;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window, div};

use super::nav_parts::{action_button, icon_cluster, sidebar};
use super::{Story, probe};
use crate::copy::Lang;

struct Copy {
    projects: &'static str,
    new_project: &'static str,
    space: &'static str,
    create_group: &'static str,
    new_chat: &'static str,
    space_menu: &'static str,
    favorites: &'static str,
    favorites_hint: &'static str,
    items: [&'static str; 3],
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            projects: "Projects",
            new_project: "New project",
            space: "Space",
            create_group: "New group",
            new_chat: "New chat",
            space_menu: "Space menu",
            favorites: "Favorites",
            favorites_hint: "Star a conversation or folder to keep it here.",
            items: ["butler", "butler-site", "research-notes"],
        },
        Copy {
            projects: "프로젝트",
            new_project: "새 프로젝트",
            space: "스페이스",
            create_group: "새 그룹",
            new_chat: "새 대화",
            space_menu: "스페이스 메뉴",
            favorites: "즐겨찾기",
            favorites_hint: "대화나 폴더에 별표를 달면 여기에 모입니다.",
            items: ["butler", "butler-site", "research-notes"],
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Sidebar section (SidebarSection)",
            render: section,
        },
        Story {
            name: "Collapsed section",
            render: collapsed,
        },
        Story {
            name: "Heading only (NavSectionHeading)",
            render: heading_only,
        },
    ]
}

fn section(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let actions = icon_cluster([
        action_button("ns-new-project", c.new_project, Icon::FolderPlus).into_any_element(),
    ]);
    let mut section = NavSection::new("ns-projects", c.projects).actions(actions);
    for (index, item) in c.items.iter().enumerate() {
        let row = NavRow::new(gpui::SharedString::from(format!("ns-row-{index}")), *item)
            .glyph(Icon::Folder)
            .on_click(|_, _, _| {});
        section = section.child(if index == 0 { row.active() } else { row });
    }
    sidebar("ns-section-sidebar", [section.into_any_element()])
}

fn collapsed(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let section = NavSection::new("ns-collapsed", c.projects)
        .collapsed(true)
        .child(NavRow::new("ns-collapsed-row", c.items[0]).glyph(Icon::Folder));
    sidebar("ns-collapsed-sidebar", [section.into_any_element()])
}

/// `SpaceBrowseHeader`: new chat, then the space menu, in one icon cluster.
fn space_actions(c: &Copy, window: &mut Window, cx: &mut App) -> AnyElement {
    let menu = DropdownMenu::new("ns-space-menu", window, cx);
    let trigger = menu.trigger(|toggle| {
        action_button("ns-space-trigger", c.space_menu, Icon::FolderPlus)
            .menu_trigger()
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let content = menu.content(
        DropdownMenuContent::new()
            .align(Align::End)
            .side_offset(8.)
            .child(Item::new(c.create_group))
            .child(Item::new(c.new_project)),
        window,
        cx,
    );
    icon_cluster([
        action_button("ns-new-chat", c.new_chat, Icon::PencilLine).into_any_element(),
        div()
            .flex()
            .child(trigger)
            .child(content)
            .into_any_element(),
    ])
    .into_any_element()
}

fn heading_only(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let actions = space_actions(&c, window, cx);
    let ds = Ds::get(cx);
    let hint = Stack::row()
        .cross(Cross::Center)
        .gap(Space::Xs)
        .child(icon(Icon::Pin, IconSize::Sm, ds))
        .child(
            div()
                .min_w_0()
                .child(Typo::caption(c.favorites_hint).tone(Tone::Secondary)),
        );
    let favorites = Stack::new()
        .gap(Space::Xs)
        .child(NavSectionHeading::new(c.favorites))
        .child(
            div()
                .px(ds.len(butler_ds::tokens::Length::SpaceSm))
                .child(hint),
        );
    let body = Stack::new()
        .gap(Space::Md)
        .child(NavSectionHeading::new(c.space).actions(actions))
        .child(favorites)
        .child(probe("nav-section-heading-only".to_owned()));
    sidebar("ns-heading-sidebar", [body.into_any_element()])
}
