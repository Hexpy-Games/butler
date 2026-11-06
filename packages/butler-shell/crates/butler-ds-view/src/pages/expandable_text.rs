//! ExpandableText.showcase.tsx.
use butler_ds::ui::Icon;
use butler_ds::ui::context::Ds;
use butler_ds::ui::expandable_text::ExpandableText;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Cross, MinWidth, Space, Stack, StackItem, WithItem as _};
use butler_ds::ui::separator::Separator;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    long: &'static str,
    short: &'static str,
    multi: &'static str,
    all_chats: &'static str,
    this_chat_only: &'static str,
    expires: &'static str,
    remove: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            long: "Answer in short paragraphs, put code in fenced blocks, and when a task touches files list each changed path at the end, so I can review the diff before anything is committed.",
            short: "Reply in English.",
            multi: "Weekly report format:\n1. What shipped\n2. What slipped and why\n3. Next week's three priorities",
            all_chats: "All chats",
            this_chat_only: "This chat only",
            expires: "All chats · Expires in 5 days",
            remove: "Delete",
        },
        Copy {
            long: "답변은 짧은 문단으로 나누고 코드는 코드 블록에 넣어 주세요. 파일을 고치는 작업이면 마지막에 바뀐 경로를 모두 적어 주세요. 커밋하기 전에 차이를 확인하고 싶습니다.",
            short: "한국어로 답해 주세요.",
            multi: "주간 보고 형식:\n1. 끝낸 일\n2. 밀린 일과 이유\n3. 다음 주 우선순위 세 가지",
            all_chats: "모든 채팅",
            this_chat_only: "이 채팅에서만",
            expires: "모든 채팅 · 5일 후 만료",
            remove: "삭제",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Instruction list rows",
            render: list_rows,
        },
        Story {
            name: "Two collapsed lines",
            render: |lang, _, _| {
                ExpandableText::new("et-two", copy(lang).long)
                    .collapsed_lines(2)
                    .into_any_element()
            },
        },
        Story {
            name: "Fits: no toggle, empty chevron slot",
            render: |lang, _, _| {
                let c = copy(lang);
                ExpandableText::new("et-fits", c.short)
                    .meta(c.all_chats)
                    .into_any_element()
            },
        },
    ]
}

fn row(
    id: &'static str,
    text: &'static str,
    meta: &'static str,
    remove: &'static str,
    cx: &App,
) -> AnyElement {
    let ds = Ds::get(cx);
    Stack::row()
        .cross(Cross::Start)
        .gap(Space::Md)
        .child(
            StackItem::new()
                .grow()
                .min_width(MinWidth::Zero)
                .child(ExpandableText::new(id, text).meta(meta)),
        )
        .child(IconButton::new(format!("{id}-remove"), remove).icon(icon(
            Icon::Trash2,
            IconSize::Md,
            ds,
        )))
        .into_any_element()
}

fn list_rows(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Md)
        .child(row("et-long", c.long, c.all_chats, c.remove, cx))
        .child(Separator::new().space(Space::None))
        .child(row("et-short", c.short, c.this_chat_only, c.remove, cx))
        .child(Separator::new().space(Space::None))
        .child(row("et-multi", c.multi, c.expires, c.remove, cx))
        .into_any_element()
}
