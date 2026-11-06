//! SidebarShell.showcase.tsx.
use butler_ds::tokens::{Color, Density, Length};
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::nav_row::NavRow;
use butler_ds::ui::blocks::sidebar_shell::{self, SidebarShell};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Basis, Cross, MinWidth, Radius, Space, Stack, WithItem as _};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Styled as _, Window, div,
    px,
};

use super::Story;
use crate::copy::Lang;

/// The viewer's frame: a bounded window height for the shell (`--adaptive-viewport-block-size`).
const FRAME_HEIGHT: f32 = 440.; // DS: SidebarShell.showcase.module.css:3

struct Copy {
    new_chat: &'static str,
    search: &'static str,
    automations: &'static str,
    settings: &'static str,
    filter: &'static str,
    sessions: [&'static str; 10],
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            new_chat: "New chat",
            search: "Search",
            automations: "Schedules",
            settings: "Settings",
            filter: "All · Recent · Running",
            sessions: [
                "Desktop client polish",
                "Settings hierarchy",
                "Release notes draft",
                "General chat",
                "Weekly review",
                "Travel plan",
                "Reading list",
                "Budget check",
                "Interview prep",
                "Bug triage",
            ],
        },
        Copy {
            new_chat: "새 대화",
            search: "검색",
            automations: "예약 작업",
            settings: "설정",
            filter: "전체 · 최근 · 실행 중",
            sessions: [
                "데스크톱 앱 다듬기",
                "설정 화면 위계",
                "릴리스 노트 초안",
                "일반 대화",
                "주간 회고",
                "여행 계획",
                "읽을거리",
                "예산 점검",
                "면접 준비",
                "버그 분류",
            ],
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Default",
            render: default,
        },
        Story {
            name: "Scrolling list with sticky filter",
            render: scrolling,
        },
        Story {
            name: "Row fills: white base and tinted shell",
            render: row_fills,
        },
        Story {
            name: "Densities (compact, comfortable, touch)",
            render: densities,
        },
    ]
}

/// One sidebar of the showcase: `rows` sessions, an optional density and brand title.
fn sidebar(
    id: &'static str,
    lang: Lang,
    (rows, density, brand): (usize, Option<(Density, &'static str)>, bool),
    cx: &App,
) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let titlebar = match (brand, density) {
        (true, Some((_, name))) => sidebar_shell::brand(
            Typo::new(butler_ds::ui::typo::Role::AppTitle, name),
            true,
            ds,
        ),
        (true, None) => sidebar_shell::brand(
            Typo::new(butler_ds::ui::typo::Role::AppTitle, "comfortable"),
            true,
            ds,
        ),
        _ => sidebar_shell::traffic_space(),
    };
    let row_id = |name: &str| SharedString::from(format!("{id}-{name}"));
    let nav = sidebar_shell::nav(
        [
            NavRow::new(row_id("new"), c.new_chat)
                .glyph(Icon::PencilLine)
                .active()
                .on_click(|_, _, _| {})
                .into_any_element(),
            NavRow::new(row_id("search"), c.search)
                .glyph(Icon::Search)
                .on_click(|_, _, _| {})
                .into_any_element(),
            NavRow::new(row_id("schedules"), c.automations)
                .glyph(Icon::Clock3)
                .on_click(|_, _, _| {})
                .into_any_element(),
        ],
        ds,
    );
    let mut shell = SidebarShell::new(id)
        .titlebar(titlebar)
        .footer(
            NavRow::new(row_id("settings"), c.settings)
                .glyph(Icon::Settings)
                .on_click(|_, _, _| {}),
        )
        .scroll_header(nav)
        .sticky_header(NavRow::new(row_id("filter"), c.filter).on_click(|_, _, _| {}));
    if let Some((density, _)) = density {
        shell = shell.density(density);
    }
    for (index, label) in c.sessions.iter().take(rows).enumerate() {
        shell = shell.child(
            NavRow::new(row_id(&format!("row-{index}")), *label)
                .badge(format!("{}d", index + 1))
                .on_click(|_, _, _| {}),
        );
    }
    div()
        .h(px(FRAME_HEIGHT))
        .overflow_hidden()
        .child(shell)
        .into_any_element()
}

fn default(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    sidebar("sidebar-default", lang, (4, None, false), cx)
}

fn scrolling(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    sidebar("sidebar-scrolling", lang, (10, None, false), cx)
}

/// `NavRowSurface`: rows on a white base (the `--selection` shades) or a tinted shell.
fn surface(tinted: bool, content: AnyElement, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let base = ds.color(Color::ColorSurfaceBase);
    let bg = if tinted {
        butler_ds::ui::convert::mix(ds.color(Color::TextPrimary), base, 0.07) // DS: NavRowSurface.module.css:23
    } else {
        base
    };
    div()
        .p(ds.len(Length::SpaceSm))
        .rounded(Radius::Control.px(ds))
        .bg(bg)
        .child(content)
        .into_any_element()
}

fn row_fills(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let side = |id: &'static str, tinted: bool, cx: &App| {
        let content = sidebar(id, lang, (4, None, false), cx);
        div()
            .flex_1()
            .min_w_0()
            .flex_basis(gpui::relative(0.))
            .child(surface(tinted, content, cx))
    };
    Stack::row()
        .gap(Space::Lg)
        .cross(Cross::Start)
        .child(side("fills-white", false, cx))
        .child(side("fills-tinted", true, cx))
        .into_any_element()
}

fn densities(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let kinds = [
        ("density-compact", Density::Compact, "compact"),
        ("density-comfortable", Density::Comfortable, "comfortable"),
        ("density-touch", Density::Touch, "touch"),
    ];
    let mut row = Stack::row().gap(Space::Lg).cross(Cross::Start);
    for (id, density, name) in kinds {
        row = row.child(
            Stack::new()
                .grow()
                .basis(Basis::Zero)
                .min_width(MinWidth::Zero)
                .child(sidebar(id, lang, (5, Some((density, name)), true), cx)),
        );
    }
    let _ = Tone::Primary;
    row.into_any_element()
}
