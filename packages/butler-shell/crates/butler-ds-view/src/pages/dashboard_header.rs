//! DashboardHeader.showcase.tsx: the project dashboard header, the schedules list header and a
//! header with a description and a meta line.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::dashboard_header::DashboardHeader;
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use gpui::{AnyElement, App, IntoElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    project: &'static str,
    new_chat: &'static str,
    automations: &'static str,
    scheduled: &'static str,
    new_automation: &'static str,
    dashboard: &'static str,
    description: &'static str,
    chats: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            project: "butler",
            new_chat: "New chat",
            automations: "Schedules",
            scheduled: "3 scheduled",
            new_automation: "New schedule",
            dashboard: "Project dashboard",
            description: "Work history and project context",
            chats: "12 project chats",
        },
        Copy {
            project: "butler",
            new_chat: "새 채팅",
            automations: "예약 작업",
            scheduled: "예약 3개",
            new_automation: "새 예약 작업",
            dashboard: "프로젝트 대시보드",
            description: "작업 기록과 프로젝트 맥락",
            chats: "프로젝트 채팅 12개",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Project dashboard",
            render: project,
        },
        Story {
            name: "Automations list",
            render: automations,
        },
        Story {
            name: "Description and meta",
            render: described,
        },
    ]
}

fn action(id: &'static str, glyph: Icon, text: &'static str, variant: Variant, cx: &App) -> Button {
    Button::new(id)
        .variant(variant)
        .icon_start(icon(glyph, IconSize::Md, Ds::get(cx)))
        .text(text)
}

fn project(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    DashboardHeader::new(c.project)
        .action(action(
            "dh-project-new",
            Icon::MessageSquarePlus,
            c.new_chat,
            Variant::Outline,
            cx,
        ))
        .into_any_element()
}

fn automations(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    DashboardHeader::new(c.automations)
        .meta(c.scheduled)
        .action(action(
            "dh-automations-new",
            Icon::Plus,
            c.new_automation,
            Variant::Outline,
            cx,
        ))
        .into_any_element()
}

fn described(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    DashboardHeader::new(c.dashboard)
        .description(c.description)
        .meta(c.chats)
        .action(action(
            "dh-described-new",
            Icon::MessageSquarePlus,
            c.new_chat,
            Variant::Default,
            cx,
        ))
        .into_any_element()
}
