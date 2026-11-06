//! NavRow.showcase.tsx (with fixtures/NavRowNested.tsx): sidebar rows in the app's SidebarShell,
//! two-line rows, the swapped trailing slot, the three densities, nested rows and label-only
//! rows. The states matrix is covered by the live harness (hover, focus, active).
use butler_ds::tokens::Density;
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::nav_row::{NavRow, NavRowChildren, NavRowSwap};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_slot::{IconSlot, SlotSize};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window};

use super::nav_parts::{action_button, icon_cluster, row_menu, sidebar};
use super::{Story, probe};
use crate::copy::Lang;

pub(super) struct Copy {
    pub(super) general: &'static str,
    pub(super) project: &'static str,
    pub(super) active: &'static str,
    pub(super) long: &'static str,
    pub(super) menu: &'static str,
    pub(super) disabled: &'static str,
    pub(super) recent: &'static str,
    pub(super) recent_meta: &'static str,
    pub(super) more: &'static str,
    pub(super) back: &'static str,
    pub(super) skills: &'static str,
    pub(super) rename: &'static str,
    pub(super) archive: &'static str,
    pub(super) dashboard: &'static str,
    pub(super) expand: &'static str,
    pub(super) unread: &'static str,
    pub(super) details: &'static str,
    pub(super) resume: &'static str,
    pub(super) parent: &'static str,
    pub(super) children: [&'static str; 3],
}

pub(super) fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            general: "Chats",
            project: "butler",
            active: "Design-system viewer",
            long: "Settings with a very long navigation label that truncates before the control region",
            menu: "Row actions",
            disabled: "Archived project",
            recent: "Release checklist review",
            recent_meta: "butler · 3 minutes ago",
            more: "More (12)",
            back: "Back to app",
            skills: "Skills",
            rename: "Rename",
            archive: "Archive",
            dashboard: "Dashboard",
            expand: "Expand",
            unread: "Unread",
            details: "View progress details",
            resume: "Resume",
            parent: "Find the sign-in error",
            children: [
                "Review the token refresh logic",
                "Tidy the regression tests",
                "Group the failure logs by hour",
            ],
        },
        Copy {
            general: "대화",
            project: "butler",
            active: "디자인 시스템 뷰어",
            long: "컨트롤 영역에 닿기 전에 말줄임되는 아주 긴 내비게이션 라벨이 있는 설정",
            menu: "행 작업",
            disabled: "보관된 프로젝트",
            recent: "릴리스 체크리스트 검토",
            recent_meta: "butler · 3분 전",
            more: "더 보기 (12)",
            back: "앱으로 돌아가기",
            skills: "스킬",
            rename: "이름 바꾸기",
            archive: "보관",
            dashboard: "대시보드",
            expand: "펼치기",
            unread: "읽지 않음",
            details: "진행 상세 보기",
            resume: "이어서 진행",
            parent: "로그인 오류 원인 찾기",
            children: [
                "토큰 갱신 로직 검토",
                "회귀 테스트 정리",
                "실패 로그를 시간대별로 정리",
            ],
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Sidebar rows",
            render: sidebar_rows,
        },
        Story {
            name: "Two lines (meta)",
            render: two_lines,
        },
        Story {
            name: "Swap trailing slot (NavRowSwap)",
            render: swap,
        },
        Story {
            name: "Densities",
            render: densities,
        },
        Story {
            name: "Nested rows (NavRowChildren)",
            render: nested,
        },
        Story {
            name: "Label-only rows (load more, settings back, skills)",
            render: label_only,
        },
    ]
}

fn menu_copy(c: &Copy) -> (&'static str, &'static str, &'static str, &'static str) {
    (c.menu, c.rename, c.archive, c.unread)
}

/// A row's menu keyed by the row it belongs to.
pub(super) fn menu(id: &str, c: &Copy, rest: Option<AnyElement>, open: bool) -> AnyElement {
    row_menu(SharedString::from(id.to_owned()), rest, open, menu_copy(c))
}

/// `projectActions`: the dashboard button, then the row menu (behind the disclosure chevron
/// when given).
fn project_actions(id: &str, c: &Copy, chevron: Option<AnyElement>, open: bool) -> AnyElement {
    let dashboard = action_button(
        SharedString::from(format!("{id}-dashboard")),
        format!("{} {}", c.project, c.dashboard),
        Icon::LayoutDashboard,
    )
    .into_any_element();
    let menu = menu(&format!("{id}-menu"), c, None, open);
    let tail = match chevron {
        Some(chevron) => NavRowSwap::new(SharedString::from(format!("{id}-swap")), menu)
            .rest(chevron)
            .open(open)
            .into_any_element(),
        None => menu,
    };
    icon_cluster([dashboard, tail]).into_any_element()
}

fn sidebar_rows(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let rows = Stack::new()
        .gap(Space::Xs)
        .child(
            NavRow::new("nr-general", c.general)
                .glyph(Icon::GeneralChat)
                .on_click(|_, _, _| {}),
        )
        .child(
            NavRow::new("nr-active", c.active)
                .glyph(Icon::Notebook)
                .active()
                .on_click(|_, _, _| {})
                .actions(menu("nr-active-menu", &c, None, false)),
        )
        .child(
            NavRow::new("nr-long", c.long)
                .glyph(Icon::Settings)
                .badge("3")
                .on_click(|_, _, _| {}),
        )
        .child(
            NavRow::new("nr-project", c.project)
                .glyph(Icon::Folder)
                .on_click(|_, _, _| {})
                .actions(project_actions("nr-project-actions", &c, None, false)),
        )
        .child(
            NavRow::new("nr-disabled", c.disabled)
                .glyph(Icon::Folder)
                .disabled(),
        );
    sidebar("nr-sidebar", [rows.into_any_element()])
}

fn two_lines(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    // A plain `<span>`: it takes the row's own text style.
    let meta = c.recent_meta;
    sidebar(
        "nr-two-lines-sidebar",
        [NavRow::new("nr-two-lines", c.recent)
            .multiline()
            .glyph(Icon::Notebook)
            .meta(meta)
            .on_click(|_, _, _| {})
            .actions(menu("nr-two-lines-menu", &c, None, false))
            .into_any_element()],
    )
}

/// `<IconSlot size="sidebar" minHeight="line" passive role="status">`.
pub(super) fn mark(content: impl gpui::IntoElement) -> AnyElement {
    IconSlot::new()
        .size(SlotSize::Sidebar)
        .min_line()
        .child(content)
        .into_any_element()
}

fn swap(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let side = f32::from(Ds::get(cx).len(butler_ds::tokens::Length::SidebarIconSize));
    let working = mark(Spinner::new("nr-swap-spinner").size(side));
    let chevron = action_button(
        "nr-swap-chevron",
        format!("{} {}", c.project, c.expand),
        Icon::ChevronRight,
    )
    .into_any_element();
    let rows = Stack::new()
        .gap(Space::Xs)
        .child(
            NavRow::new("nr-swap-chat", c.active)
                .glyph(Icon::Notebook)
                .on_click(|_, _, _| {})
                .actions(menu("nr-swap-chat-menu", &c, Some(working), false)),
        )
        .child(
            NavRow::new("nr-swap-project", c.project)
                .glyph(Icon::Folder)
                .on_click(|_, _, _| {})
                .actions(project_actions(
                    "nr-swap-project-actions",
                    &c,
                    Some(chevron),
                    true,
                )),
        );
    sidebar("nr-swap-sidebar", [rows.into_any_element()])
}

fn densities(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let kinds = [
        (Density::Compact, "compact"),
        (Density::Comfortable, "comfortable"),
        (Density::Touch, "touch"),
    ];
    Stack::new()
        .gap(Space::Sm)
        .children(kinds.map(|(density, name)| {
            NavRow::new(
                SharedString::from(format!("nr-density-{name}")),
                format!("{} · {name}", c.recent),
            )
            .glyph(Icon::Notebook)
            .density(density)
            .on_click(|_, _, _| {})
        }))
        .into_any_element()
}

fn nested(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let details = |id: String| action_button(id, c.details, Icon::Eye).into_any_element();
    let kinds = [
        (Density::Compact, "compact"),
        (Density::Comfortable, "comfortable"),
        (Density::Touch, "touch"),
    ];
    let mut column = Stack::new().gap(Space::Lg);
    for (density, name) in kinds {
        let side = {
            let tokens = butler_ds::tokens::TokenContext {
                density,
                ..*ds.tokens()
            };
            tokens.len(butler_ds::tokens::Length::SidebarIconSize)
        };
        let id = |part: &str| SharedString::from(format!("nn-{name}-{part}"));
        let working = mark(Spinner::new(id("spinner")).size(side));
        let parent = NavRow::new(id("parent"), format!("{} · {name}", c.parent))
            .glyph(Icon::Notebook)
            .density(density)
            .on_click(|_, _, _| {})
            .actions(
                NavRowSwap::new(id("parent-swap"), details(format!("nn-{name}-d0"))).rest(working),
            );
        let count = Typo::caption("3/5")
            .tone(Tone::Secondary)
            .tabular()
            .wrap(butler_ds::ui::typo::Wrap::Nowrap);
        let kids = NavRowChildren::new()
            .density(density)
            .child(
                NavRow::new(id("c0"), c.children[0])
                    .reserve_icon()
                    .density(density)
                    .on_click(|_, _, _| {})
                    .actions(
                        NavRowSwap::new(id("c0-swap"), details(format!("nn-{name}-d1")))
                            .rest(count),
                    ),
            )
            .child(
                NavRow::new(id("c1"), c.children[1])
                    .reserve_icon()
                    .density(density)
                    .on_click(|_, _, _| {})
                    .actions(action_button(id("c1-resume"), c.resume, Icon::Play)),
            )
            .child(
                NavRow::new(id("c2"), c.children[2])
                    .reserve_icon()
                    .density(density)
                    .on_click(|_, _, _| {})
                    .actions(
                        NavRowSwap::new(id("c2-swap"), details(format!("nn-{name}-d2")))
                            .rest(mark(icon(Icon::CircleAlert, IconSize::Sm, Ds::get(cx)))),
                    ),
            );
        column = column.child(Stack::new().gap(Space::None).child(parent).child(kids));
    }
    column.into_any_element()
}

fn label_only(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Xs)
        .child(
            NavRow::new("lo-back", c.back)
                .icon(icon(Icon::ArrowLeft, IconSize::Lg, Ds::get(cx)))
                .on_click(|_, _, _| {}),
        )
        .child(
            NavRow::new("lo-skills", c.skills)
                .active()
                .on_click(|_, _, _| {}),
        )
        .child(
            NavRow::new("lo-more", "")
                .label_element(Typo::text(c.more).tone(Tone::Secondary))
                .reserve_icon()
                .on_click(|_, _, _| {}),
        )
        .child(probe("nav-row-label-only".to_owned()))
        .into_any_element()
}
