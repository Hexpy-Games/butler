//! SurfacePanel.showcase.tsx.
use butler_ds::ui::blocks::surface_panel::{Elevation, PanelRadius, SurfacePanel};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::layout::{Basis, Cross, Justify, MinWidth, Space, Stack, WithItem as _};
use butler_ds::ui::typo::{Role, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    usage: &'static str,
    usage_meta: &'static str,
    tokens: &'static str,
    archived: &'static str,
    archived_meta: &'static str,
    restore: &'static str,
    elevation: &'static str,
    work: &'static str,
    work_meta: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            usage: "API provider usage",
            usage_meta: "OpenAI · this month",
            tokens: "1.2M tokens",
            archived: "Release checklist review",
            archived_meta: "Conversation · 3 days ago",
            restore: "Restore",
            elevation: "elevation",
            work: "Compare three laptop reviews",
            work_meta: "Running · 2 of 4 sources read",
        },
        Copy {
            usage: "API 제공자 사용량",
            usage_meta: "OpenAI · 이번 달",
            tokens: "120만 토큰",
            archived: "릴리스 체크리스트 검토",
            archived_meta: "대화 · 3일 전",
            restore: "복원",
            elevation: "높이",
            work: "노트북 리뷰 세 곳 비교",
            work_meta: "진행 중 · 자료 4개 중 2개 읽음",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Settings row panel",
            render: settings_row,
        },
        Story {
            name: "Archive item",
            render: archive,
        },
        Story {
            name: "Elevations",
            render: elevations,
        },
        Story {
            name: "In the conversation (radius lg)",
            render: conversation,
        },
        Story {
            name: "Subtle (document in a message)",
            render: subtle,
        },
    ]
}

fn settings_row(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    SurfacePanel::new()
        .elevation(Elevation::None)
        .child(
            Stack::row()
                .justify(Justify::Between)
                .cross(Cross::Start)
                .gap(Space::Md)
                .wrap(true)
                .child(
                    Stack::new()
                        .gap(Space::Xs)
                        .grow()
                        .basis(Basis::Md)
                        .min_width(MinWidth::Zero)
                        .child(Typo::body(c.usage))
                        .child(Typo::caption(c.usage_meta)),
                )
                .child(Typo::metric_value(c.tokens)),
        )
        .into_any_element()
}

fn archive(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    SurfacePanel::new()
        .elevation(Elevation::None)
        .child(
            Stack::row()
                .cross(Cross::Center)
                .gap(Space::Md)
                .justify(Justify::Between)
                .wrap(true)
                .child(
                    Stack::new()
                        .gap(Space::Xs)
                        .child(Typo::body(c.archived))
                        .child(Typo::caption(c.archived_meta)),
                )
                .child(
                    Button::new("surface-panel-restore")
                        .size(Size::Sm)
                        .variant(Variant::Outline)
                        .text(c.restore),
                ),
        )
        .into_any_element()
}

fn elevations(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let levels = [
        (Elevation::None, "none"),
        (Elevation::Low, "low"),
        (Elevation::Medium, "medium"),
        (Elevation::High, "high"),
    ];
    Stack::new()
        .gap(Space::Md)
        .children(levels.map(|(elevation, name)| {
            SurfacePanel::new()
                .elevation(elevation)
                .child(Typo::caption(format!("{}: {name}", c.elevation)))
        }))
        .into_any_element()
}

fn conversation(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    SurfacePanel::new()
        .elevation(Elevation::None)
        .radius(PanelRadius::Lg)
        .child(
            Stack::new()
                .gap(Space::Xs)
                .child(Typo::new(Role::Label, c.work))
                .child(Typo::caption(c.work_meta)),
        )
        .into_any_element()
}

fn subtle(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    SurfacePanel::new()
        .elevation(Elevation::Subtle)
        .child(Typo::body(
            "elevation=\"subtle\": no shadow, a translucent raised fill.",
        ))
        .into_any_element()
}
