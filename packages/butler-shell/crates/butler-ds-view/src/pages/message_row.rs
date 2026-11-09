//! MessageRow.showcase.tsx (+ MessageRow.showcaseParts.tsx, ActivityTurn.showcase.tsx): the
//! activity turns, the default turn, the Chats bubble and the send-and-stream demo. The Chats
//! bubble's document row is the ArtifactList.
use butler_ds::ui::motion;
use std::time::Duration;

use butler_ds::tokens::Length;
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::artifact_list::{ArtifactItem, ArtifactList};
use butler_ds::ui::blocks::markdown_content::MarkdownContent;
use butler_ds::ui::blocks::message_row::{
    Entering, MessageBubble, MessageBubbleAttachments, MessageFooter, MessageRow,
    MessageStatusLabel, MessageStatusRow, MessageTurnGroup, Role,
};
use butler_ds::ui::blocks::work_activity::WorkActivityBlock;
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::copy_button::CopyButton;
use butler_ds::ui::icon::{IconSize, icon, icon_px};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::typo::{Role as TypoRole, Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window, div, px};

use super::Story;
use crate::copy::Lang;

#[derive(Clone, Copy)]
struct Footer {
    copy: &'static str,
    copied: &'static str,
    branch_chat: &'static str,
    branch_project: &'static str,
    completed: &'static str,
    worked_for: &'static str,
}

fn footer_labels(lang: Lang) -> Footer {
    lang.pick(
        Footer {
            copy: "Copy message",
            copied: "Copied",
            branch_chat: "Branch into a new chat",
            branch_project: "Branch into a project",
            completed: "Response completed",
            worked_for: "Worked for 9s",
        },
        Footer {
            copy: "메시지 복사",
            copied: "복사됨",
            branch_chat: "새 대화로 분기",
            branch_project: "프로젝트로 분기",
            completed: "응답 완료",
            worked_for: "9초 동안 작업",
        },
    )
}

/// The user footer as in the product: sent time, then the icon copy action.
fn user_footer(id: &str, text: &str, time: &'static str, l: Footer) -> MessageFooter {
    MessageFooter::new()
        .child(Typo::text(time).tabular())
        .child(CopyButton::new(format!("{id}-copy"), l.copy, l.copied).text(text))
}

/// The assistant footer: icon actions, duration and time, then the terminal status row.
fn assistant_footer(id: &str, text: &str, time: &'static str, l: Footer) -> [AnyElement; 2] {
    let footer = MessageFooter::new()
        .child(CopyButton::new(format!("{id}-copy"), l.copy, l.copied).text(text))
        .child(
            IconButton::new(format!("{id}-branch-chat"), l.branch_chat)
                .glyph(Icon::MessageSquarePlus),
        )
        .child(
            IconButton::new(format!("{id}-branch-project"), l.branch_project)
                .glyph(Icon::FolderPlus),
        )
        .child(div().child(l.worked_for))
        .child(Typo::text(time).tabular())
        .flush();
    let status = MessageStatusRow::new().flush().child(
        MessageStatusLabel::new(
            format!("{id}-status"),
            // The mark fills its 18px box (`.statusMark svg`).
            icon_px(Icon::CheckCircle2, px(18.)),
        )
        .child(Typo::caption(l.completed)),
    );
    [footer.into_any_element(), status.into_any_element()]
}

struct Copy {
    question: &'static str,
    summary: &'static str,
    thinking: &'static str,
    send: &'static str,
    answer: String,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            question: "Summarize the motion system.",
            summary: "Motion is short and decelerating on the way in, faster on the way out, and only a fade under reduced motion.",
            thinking: "Thinking",
            send: "Send",
            answer: [
                "## Motion system",
                "",
                "Butler motion is **Linear-crisp**: short, decelerating entrances and faster exits.",
                "",
                "- Overlays fade and scale from their trigger.",
                "- Buttons press in on `--motion-instant`.",
                "- Streaming text fades in chunk by chunk without layout shifts.",
                "",
                "Reduced motion keeps every fade and drops the travel.",
            ]
            .join("\n"),
        },
        Copy {
            question: "모션 시스템을 요약해 줘.",
            summary: "모션은 들어올 때 짧게 감속하고 나갈 때 더 빠르며, 동작 줄이기에서는 페이드만 남습니다.",
            thinking: "생각하는 중",
            send: "보내기",
            answer: [
                "## 모션 시스템",
                "",
                "버틀러 모션은 **Linear-crisp** 입니다. 짧고 감속하는 진입, 더 빠른 퇴장.",
                "",
                "- 오버레이는 트리거 위치에서 페이드와 스케일로 열립니다.",
                "- 버튼은 `--motion-instant` 로 눌립니다.",
                "- 스트리밍 텍스트는 레이아웃 이동 없이 조각마다 나타납니다.",
                "",
                "동작 줄이기 설정에서는 이동 없이 페이드만 남습니다.",
            ]
            .join("\n"),
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Running activity",
            render: |lang, w, cx| activity_turn(lang, "mr-running", 1, true, w, cx),
        },
        Story {
            name: "Completed activity",
            render: |lang, w, cx| activity_turn(lang, "mr-completed", 1, false, w, cx),
        },
        Story {
            name: "Completed turns",
            render: |lang, w, cx| activity_turn(lang, "mr-turns", 4, false, w, cx),
        },
        Story {
            name: "Default",
            render: |lang, _, cx| default_turn(lang, cx),
        },
        Story {
            name: "Chats bubble",
            render: |lang, _, _| bubble_turn(lang),
        },
        Story {
            name: "Send and stream",
            render: send_and_stream,
        },
    ]
}

fn activity_turn(
    lang: Lang,
    id: &'static str,
    count: usize,
    running: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let l = footer_labels(lang);
    let mut group = MessageTurnGroup::new();
    for index in 0..count {
        group = group.row(activity_row(
            lang,
            &format!("{id}-{index}"),
            running,
            l,
            window,
            cx,
        ));
    }
    group.into_any_element()
}

fn activity_row(
    lang: Lang,
    id: &str,
    running: bool,
    l: Footer,
    window: &mut Window,
    cx: &mut App,
) -> MessageRow {
    let expanded = window.use_keyed_state(format!("{id}-expanded"), cx, |_, _| false);
    let open = *expanded.read(cx);
    let summary = lang.pick("Activity · Completed · 1 record", "활동 · 완료 · 1개 기록");
    let label = if running {
        lang.pick("Current · Working · 1 record", "현재 · 작업 중 · 1개 기록")
    } else {
        summary
    };
    let ds = Ds::get(cx);
    let chevron = icon(
        if open {
            Icon::ChevronDown
        } else {
            Icon::ChevronRight
        },
        IconSize::Sm,
        ds,
    );
    let toggle = Button::new(format!("{id}-toggle"))
        .variant(Variant::Inline)
        .text(label)
        .icon_end(chevron)
        .on_click(move |_, _, cx| {
            expanded.update(cx, |open, cx| {
                *open = !*open;
                cx.notify();
            });
        });
    let activity = (running || open).then(|| {
        WorkActivityBlock::new(
            format!("{id}-activity"),
            lang.pick("Review the activity surface", "활동 화면 확인"),
        )
        .compact()
    });
    let mut row = MessageRow::new(id.to_owned(), Role::Assistant)
        .child(Stack::new().gap(Space::Sm).child(toggle).children(activity));
    row = row.child(Typo::body(lang.pick(
        "The activity stays attached to the answer.",
        "확인한 활동을 답변과 함께 표시합니다.",
    )));
    if running {
        row.child(Typo::caption(
            lang.pick("Generating answer", "응답 생성 중"),
        ))
    } else {
        let [footer, status] = assistant_footer(id, summary, "9:09", l);
        row.child(footer).child(status)
    }
}

fn default_turn(lang: Lang, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let (c, l) = (copy(lang), footer_labels(lang));
    let [footer, status] = assistant_footer("mr-default", c.summary, "9:09", l);
    Stack::new()
        .gap(Space::None)
        .child(
            MessageRow::new("mr-default-user", Role::User)
                .footer(user_footer("mr-default-user", c.question, "9:08", l))
                .child(c.question),
        )
        .child(
            MessageRow::new("mr-default-assistant", Role::Assistant)
                .child(
                    // A bare `<p>`: the user agent's one-em block margins.
                    div()
                        .my(ds.len(Length::FontSize3))
                        .child(Typo::body(c.summary).tone(Tone::Inherit)),
                )
                .child(footer)
                .child(status),
        )
        .into_any_element()
}

/// The ArtifactList of one document: its icon tile, the name and its meta.
fn document_row(title: &'static str, meta: &'static str) -> AnyElement {
    ArtifactList::new("mr-artifacts")
        .item(
            ArtifactItem::new(title)
                .description(meta)
                .on_open(|_, _, _| {}),
        )
        .into_any_element()
}

fn bubble_turn(lang: Lang) -> AnyElement {
    let l = footer_labels(lang);
    let (question, reply, document, meta) = lang.pick(
        (
            "Can you sum up the exchange rate and the US market this week?",
            "Done. The dollar held near 1,380 won all week, and US stocks rose on tech. The details are in the document.",
            "Exchange rate and US market, Oct 20–24",
            "Document",
        ),
        (
            "이번 주 환율이랑 미국 증시 흐름 좀 정리해 줄래요?",
            "정리해 뒀어요. 달러는 한 주 내내 1,380원 근처였고, 미국 증시는 기술주 위주로 올랐어요. 자세한 건 문서에 담았어요.",
            "환율·미국 증시 정리 (10월 20–24일)",
            "문서",
        ),
    );
    Stack::new()
        .gap(Space::None)
        .child(
            MessageRow::new("mr-bubble-user", Role::User)
                .footer(user_footer("mr-bubble-user", question, "7:48", l))
                .child(question),
        )
        .child(
            MessageRow::new("mr-bubble-assistant", Role::Assistant)
                .bubble()
                .child(MessageBubble::new().child(MarkdownContent::new("mr-bubble-md", reply)))
                .child(MessageBubbleAttachments::new().child(document_row(document, meta)))
                .child(
                    MessageFooter::new()
                        .child(CopyButton::new("mr-bubble-copy", l.copy, l.copied).text(reply))
                        .child(Typo::text("7:49").tabular()),
                ),
        )
        .into_any_element()
}

/// Chunk cadence of the demo stream: 25 chunks a second. // DS: MessageRow.showcase.tsx:52
const CHUNK_INTERVAL: Duration = Duration::from_millis(40);
const CHUNK_SIZE: usize = 4;
const THINKING: Duration = Duration::from_millis(900);
const ASSISTANT_AT: Duration = Duration::from_millis(160);

fn send_and_stream(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let (c, l) = (copy(lang), footer_labels(lang));
    let sent = window.use_keyed_state("mr-stream-sent", cx, |_, _| None::<std::time::Instant>);
    let now = cx.background_executor().now();
    let elapsed = (*sent.read(cx)).map(|at| now.saturating_duration_since(at));
    let total = c.answer.chars().count().div_ceil(CHUNK_SIZE);
    let finished = elapsed.is_some_and(|e| {
        e >= ASSISTANT_AT + THINKING + CHUNK_INTERVAL * u32::try_from(total).unwrap_or(0)
    });
    if elapsed.is_some() {
        window.use_keyed_state(format!("mr-ticker-{:?}", sent.read(cx)), cx, |_, cx| {
            cx.spawn(async move |this, cx| {
                let steps = [ASSISTANT_AT, THINKING]
                    .into_iter()
                    .chain(std::iter::repeat_n(CHUNK_INTERVAL, total));
                for step in steps {
                    motion::sleep(cx.background_executor(), step).await;
                    if this.update(cx, |_, cx| cx.notify()).is_err() {
                        return;
                    }
                }
            })
        });
    }
    let send = Button::new("mr-stream-send")
        .text(c.send)
        .on_click(move |_, _, cx| {
            sent.update(cx, |at, cx| {
                *at = Some(cx.background_executor().now());
                cx.notify();
            });
        });
    let mut list = Stack::new().gap(Space::None);
    if let Some(elapsed) = elapsed {
        list = list.child(
            MessageRow::new("mr-stream-user", Role::User)
                .entering(Entering::Yes)
                .footer(user_footer("mr-stream-user", c.question, "9:08", l))
                .child(c.question),
        );
        if elapsed >= ASSISTANT_AT {
            let since = elapsed.saturating_sub(ASSISTANT_AT);
            let thinking = since < THINKING;
            let chunks = if thinking {
                0
            } else {
                (since.saturating_sub(THINKING).as_millis() / CHUNK_INTERVAL.as_millis()) as usize
            };
            let shown = (chunks * CHUNK_SIZE).min(c.answer.chars().count());
            let text: String = c.answer.chars().take(shown).collect();
            let streaming = !finished;
            let mut row =
                MessageRow::new("mr-stream-assistant", Role::Assistant).entering(Entering::Yes);
            row = if thinking {
                row.child(
                    MessageStatusRow::new().child(
                        MessageStatusLabel::new(
                            "mr-stream-thinking",
                            Spinner::new("mr-stream-spin").size(14.).fit(18.),
                        )
                        .shimmer(TypoRole::Body, c.thinking),
                    ),
                )
            } else {
                row.child(MarkdownContent::new("mr-stream-md", text).streaming(streaming))
            };
            if finished {
                let [footer, status] = assistant_footer("mr-stream", c.summary, "9:09", l);
                row = row.child(footer).child(status);
            }
            list = list.child(row);
        }
    }
    Stack::new()
        .gap(Space::Md)
        .child(send)
        .child(list)
        .into_any_element()
}
