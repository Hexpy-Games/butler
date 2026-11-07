//! PromptSuggestionList.showcase.tsx (+ ConversationShell.demo.tsx `SharedBackground`): the new
//! chat over a wallpaper, over a plain background, and over one wallpaper shared with the
//! messages. The live Wallpaper engine is a block of a later batch: a flat gray stands in for the
//! gray silk, and a still gradient for the shared story's aurora. The messages are the
//! conversation-shell page's stand-in rows.
use butler_ds::tokens::{Color, Length};
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::conversation_shell::{
    ConversationScroll, ConversationShell, MessageListSurface,
};
use butler_ds::ui::blocks::prompt_suggestion_list::{
    ContentRect, PromptSuggestionItem, PromptSuggestionList,
};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::icon_px;
use gpui::{
    AnyElement, App, ElementId, IntoElement as _, ParentElement as _, Styled as _, Window, div, px,
};

use super::Story;
use crate::copy::Lang;
use crate::standins_shell::message_row;

/// `.showcaseStage`: a bounded, painted box so the wallpaper layer stays inside.
const STAGE_HEIGHT: f32 = 640.; // DS: PromptSuggestionList.showcase.module.css:4
/// `composerReserve` of the new-chat stories.
const RESERVE: f32 = 160.; // DS: PromptSuggestionList.showcase.tsx:53
/// `composerReserve` of the shared-background story.
const SHARED_RESERVE: f32 = 24.; // DS: ConversationShell.demo.tsx:47

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "New chat",
            render: |lang, window, cx| suggestions(lang, true, window, cx),
        },
        Story {
            name: "Plain background",
            render: |lang, window, cx| suggestions(lang, false, window, cx),
        },
        Story {
            name: "External wallpaper (shared with the messages)",
            render: shared,
        },
    ]
}

struct Copy {
    title: &'static str,
    description: &'static str,
    moment: &'static str,
    /// Id, title, description and the prompt it stands for.
    suggestions: [(&'static str, &'static str, &'static str, &'static str); 4],
    reply: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            title: "What should we open today?",
            description: "Gather scattered context in one place and pick the next thing you can move on now.",
            moment: "2:10 PM",
            suggestions: [
                ("review", "Look at the risky parts first", "Find missed checks and places to revisit in recent changes.", "Skim the risks and missing checks in the recent changes"),
                ("plan", "Set today's order", "Lay the open work out again in an order you can act on.", "Put today's work in the order I should do it"),
                ("projects", "Mark where things are stuck", "Quietly separate the places in a project where context broke off.", "Find where the project is stuck"),
                ("briefing", "Bring back parked ideas", "Fold ideas and notes so they can become the next action.", "Turn my parked ideas into task cards"),
            ],
            reply: "Here is today's order: finish the review, then the release notes.",
        },
        Copy {
            title: "오늘의 일을 같이 펼쳐볼까요",
            description: "흩어진 맥락을 한곳에 모으고, 지금 붙잡을 수 있는 다음 일을 골라보세요.",
            moment: "오후 2:10",
            suggestions: [
                ("review", "위험한 부분 먼저 보기", "최근 변경사항에서 놓친 검증과 되돌아볼 지점을 찾습니다.", "최근 변경사항의 위험과 빠진 검증을 훑어줘"),
                ("plan", "오늘의 순서 세우기", "열린 일들을 실행 가능한 순서로 다시 얇게 펼칩니다.", "오늘 이어갈 일을 실행 순서로 정리해줘"),
                ("projects", "막힌 곳에 표시하기", "프로젝트 안에서 맥락이 끊긴 부분을 조용히 가릅니다.", "프로젝트 안에서 막힌 지점을 찾아줘"),
                ("briefing", "남겨둔 생각 꺼내기", "아이디어와 메모를 다음 행동으로 옮길 수 있게 접습니다.", "남겨둔 아이디어를 작업 카드로 바꿔줘"),
            ],
            reply: "오늘 순서입니다. 리뷰를 마치고 릴리스 노트를 씁니다.",
        },
    )
}

/// `SILK_GRAY`'s base colour. // DS: PromptSuggestionList.showcase.tsx:16
const SILK_GRAY_BASE: u32 = 0x00b3_b3b3;
/// How much of the gray silk shows over the canvas (the engine's silk reads about 0.63 of its
/// base over the light canvas).
const SILK_GRAY_SHARE: f32 = 0.63;

/// The gray silk of the new-chat stories: a flat gray, as the live silk's base reads at rest.
fn silk_gray() -> AnyElement {
    div()
        .size_full()
        .opacity(SILK_GRAY_SHARE)
        .bg(gpui::rgb(SILK_GRAY_BASE))
        .into_any_element()
}

/// The shared story's wallpaper: a still gradient stands in for the live aurora bloom (a block of a
/// later batch).
fn standin(cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let (from, to) = (
        ds.color(Color::ButlerInkBlue),
        ds.color(Color::ButlerInkPink),
    );
    div()
        .size_full()
        .opacity(0.18)
        .bg(gpui::linear_gradient(
            135.,
            gpui::linear_color_stop(from, 0.),
            gpui::linear_color_stop(to, 1.),
        ))
        .into_any_element()
}

/// `.showcaseStage`.
fn stage(shell: ConversationShell) -> AnyElement {
    div()
        .relative()
        .h(px(STAGE_HEIGHT))
        .overflow_hidden()
        .child(shell)
        .into_any_element()
}

fn items(copy: &Copy) -> Vec<PromptSuggestionItem> {
    copy.suggestions
        .iter()
        .map(|&(id, title, description, prompt)| {
            PromptSuggestionItem::new(id, title, description, prompt)
        })
        .collect()
}

/// `Suggestions`: the list in a conversation shell, over the wallpaper or not.
fn suggestions(lang: Lang, wallpaper: bool, _: &mut Window, _: &mut App) -> AnyElement {
    let copy = copy(lang);
    let id = if wallpaper {
        "prompt-suggestions-wallpaper"
    } else {
        "prompt-suggestions-plain"
    };
    let mut list = PromptSuggestionList::new(id, copy.title, items(&copy))
        .description(copy.description)
        .moment(copy.moment)
        .title_icon(|side| icon_px(Icon::Sparkles, side).into_any_element());
    if wallpaper {
        list = list.wallpaper(|_, _| silk_gray());
    }
    stage(ConversationShell::new(id, RESERVE).child(list))
}

/// `SharedBackground`: one wallpaper in the shell's background slot, shared by the new chat
/// (which reports its text) and the messages; picking a suggestion swaps the content, never the
/// canvas.
fn shared(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let copy = copy(lang);
    let sent = window.use_keyed_state("prompt-shared-sent", cx, |_, _| None::<usize>);
    let rect = window.use_keyed_state("prompt-shared-rect", cx, |_, _| None::<ContentRect>);
    let scroll_id = ElementId::from("prompt-shared-scroll");
    let current = *sent.read(cx);
    let body: AnyElement = match current {
        None => {
            let mut list = PromptSuggestionList::new(
                "prompt-suggestions-shared",
                copy.title,
                copy.suggestions
                    .iter()
                    .enumerate()
                    .map(|(index, &(id, title, description, _))| {
                        let sent = sent.clone();
                        PromptSuggestionItem::new(id, title, description, title).on_select(
                            move |window, cx| {
                                sent.update(cx, |sent, cx| {
                                    *sent = Some(index);
                                    cx.notify();
                                });
                                window.refresh();
                            },
                        )
                    })
                    .collect(),
            );
            let rect = rect.clone();
            list = list.on_content_rect(move |next, _, cx| {
                rect.update(cx, |rect, cx| {
                    *rect = next;
                    cx.notify();
                });
            });
            ConversationScroll::new(scroll_id)
                .masked(false)
                .scrollable(false)
                .child(list)
                .into_any_element()
        }
        Some(index) => {
            let turns = [(true, copy.suggestions[index].1), (false, copy.reply)];
            let ds_rows = turns
                .iter()
                .map(|&(user, text)| message_row(user, text, cx));
            ConversationScroll::new(scroll_id)
                .child(MessageListSurface::new().children(ds_rows))
                .into_any_element()
        }
    };
    let shell = ConversationShell::new("prompt-shared", SHARED_RESERVE)
        .background(standin(cx))
        .child(body);
    let ds = Ds::get(cx);
    div()
        .relative()
        .h(px(560.)) // DS: ConversationShell.showcase.module.css:53
        .overflow_hidden()
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .rounded(ds.len(Length::RadiusPanel))
        .child(shell)
        .into_any_element()
}
