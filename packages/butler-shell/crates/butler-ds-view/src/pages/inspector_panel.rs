//! InspectorPanel.showcase.tsx. KeyValueRow, ListRow, EmptyLine and Section are stand-ins.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::inspector_panel::{InspectorInset, InspectorPanel};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Space, Stack};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;
use crate::standins::list_row;
use crate::standins_shell::{empty_line, key_value_row, section};

struct Copy {
    branch: &'static str,
    gateway: &'static str,
    ready: &'static str,
    branch_label: &'static str,
    skills: &'static str,
    no_skills: &'static str,
    context: &'static str,
    context_meta: &'static str,
    tokens: &'static str,
    files: &'static str,
    refresh: &'static str,
    schedules: &'static str,
    nightly: &'static str,
    every: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            branch: "Branch details",
            gateway: "Gateway",
            ready: "Ready",
            branch_label: "Git branch",
            skills: "Skills",
            no_skills: "No skills used in this conversation.",
            context: "Context",
            context_meta: "Last updated just now",
            tokens: "Tokens",
            files: "Files",
            refresh: "Refresh",
            schedules: "Schedules",
            nightly: "Nightly release notes",
            every: "Every day 07:00",
        },
        Copy {
            branch: "브랜치 정보",
            gateway: "게이트웨이",
            ready: "준비됨",
            branch_label: "Git 브랜치",
            skills: "스킬",
            no_skills: "이 대화에서 사용한 스킬이 없습니다.",
            context: "컨텍스트",
            context_meta: "방금 갱신됨",
            tokens: "토큰",
            files: "파일",
            refresh: "새로고침",
            schedules: "예약 작업",
            nightly: "야간 릴리스 노트",
            every: "매일 07:00",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Summary: branch details",
            render: summary,
        },
        Story {
            name: "Icon, description and action",
            render: icon_description_action,
        },
        Story {
            name: "Skills list and empty state",
            render: skills,
        },
        Story {
            name: "Panel beside an inset Section",
            render: beside_inset,
        },
    ]
}

fn summary(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    InspectorPanel::new(c.branch)
        .child(key_value_row(c.gateway, c.ready, None, cx))
        .child(key_value_row(c.branch_label, "main", None, cx))
        .into_any_element()
}

fn icon_description_action(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    InspectorPanel::new(c.context)
        .description(c.context_meta)
        .icon(icon(Icon::Activity, IconSize::Md, ds))
        .action(
            Button::new("inspector-refresh")
                .size(Size::Xs)
                .variant(Variant::Borderless)
                .text(c.refresh),
        )
        .child(key_value_row(c.tokens, "18,240", Some("62%"), cx))
        .child(key_value_row(c.files, "8", None, cx))
        .into_any_element()
}

fn skills(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let glyph = icon(Icon::FileText, IconSize::Md, ds).into_any_element();
    InspectorPanel::new(c.skills)
        .child(list_row(
            Some(glyph),
            "butler-design-system",
            None,
            None,
            cx,
        ))
        .child(empty_line(Icon::Circle, c.no_skills, cx))
        .into_any_element()
}

fn beside_inset(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let glyph = icon(Icon::FileText, IconSize::Md, ds).into_any_element();
    let schedule = list_row(Some(glyph), c.nightly, None, Some(c.every), cx);
    Stack::new()
        .gap(Space::Md)
        .child(InspectorPanel::new(c.branch).child(key_value_row(c.gateway, c.ready, None, cx)))
        .child(InspectorInset::new().child(section(c.schedules, Space::Sm, vec![schedule])))
        .into_any_element()
}
