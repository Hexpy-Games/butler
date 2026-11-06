//! EmptyLine.showcase.tsx: a message only, the panel empty line and an icon with an action.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::button::Button;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use gpui::{AnyElement, App, IntoElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    automations: &'static str,
    artifacts: &'static str,
    sessions: &'static str,
    create: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            automations: "No schedules yet.",
            artifacts: "No artifacts in this conversation.",
            sessions: "No conversations yet",
            create: "New chat",
        },
        Copy {
            automations: "아직 예약 작업이 없습니다.",
            artifacts: "이 대화에는 산출물이 없습니다.",
            sessions: "아직 대화가 없습니다",
            create: "새 채팅",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Message only",
            render: message_only,
        },
        Story {
            name: "Panel empty line",
            render: panel_line,
        },
        Story {
            name: "With icon and action",
            render: with_action,
        },
    ]
}

fn message_only(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    EmptyLine::new(copy(lang).automations).into_any_element()
}

fn panel_line(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    EmptyLine::new(copy(lang).artifacts)
        .icon(icon(Icon::Circle, IconSize::Md, Ds::get(cx)))
        .into_any_element()
}

fn with_action(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    EmptyLine::new(c.sessions)
        .icon(icon(Icon::FileText, IconSize::Xxl, ds))
        .action(
            Button::new("el-create")
                .icon_start(icon(Icon::Plus, IconSize::Md, ds))
                .text(c.create),
        )
        .into_any_element()
}
