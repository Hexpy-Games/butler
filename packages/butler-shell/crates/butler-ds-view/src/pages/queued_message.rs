//! QueuedMessage.showcase.tsx (+ QueuedMessageStories.tsx, QueuedMessageMotionStories.tsx): a
//! queued bubble alone and in a list, long text and a long unbroken token, send now and delivery
//! (the bubble resolving into the sent one), editing (the text moves back into the composer) and a
//! failed send. The Send flight story needs the app's send-flight motion and is not mirrored.
use butler_ds::ui::motion;
use std::time::{Duration, Instant};

use butler_ds::ui::blocks::composer_card::{
    ComposerCard, SendButton, Toolbar, ToolbarSpacer, textarea,
};
use butler_ds::ui::blocks::message_row::{Entering, MessageRow, Role};
use butler_ds::ui::blocks::queued_message::{QueuedMessage, QueuedTone};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::layout::{Space, Stack};
use gpui::{
    AnyElement, App, ElementId, IntoElement as _, ParentElement as _, SharedString, Window,
};

use super::Story;
use crate::copy::Lang;

struct Copy {
    queued: &'static str,
    sending: &'static str,
    failed: &'static str,
    send_now: &'static str,
    send_now_hint: &'static str,
    edit: &'static str,
    remove: &'static str,
    retry: &'static str,
    remove_failed: &'static str,
    replay: &'static str,
    show_more: &'static str,
    show_less: &'static str,
    token: &'static str,
    messages: [&'static str; 3],
    long: &'static str,
    sent: &'static str,
    position: fn(usize, usize) -> String,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            queued: "Queued",
            sending: "Sending…",
            failed: "Send failed",
            send_now: "Send now",
            send_now_hint: "Stops the current response and sends this now",
            edit: "Edit queued message",
            remove: "Delete queued message",
            retry: "Retry message",
            remove_failed: "Delete failed message",
            replay: "Replay",
            show_more: "Show more",
            show_less: "Show less",
            token: "Check https://example.com/releases/2026-09-25/artifacts/butler-desktop-universal-build-0123456789abcdef0123456789abcdef/manifest.json?download=true&signature=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 before shipping.",
            messages: [
                "Add screenshots to the final report before sending.",
                "Also mention that MCP secrets stay redacted.",
                "Then open a draft PR.",
            ],
            long: "When you finish the migration, re-run the layout smoke at 375 and 1440, compare the screenshots with the ones from yesterday, and list every row whose height changed by more than two pixels together with the component that owns it. If anything moved in the sidebar, stop there and ask me before touching the tokens.",
            sent: "Summarize the motion system.",
            position: |position, total| format!("Queued · {position} of {total}"),
        },
        Copy {
            queued: "대기 중",
            sending: "보내는 중…",
            failed: "전송 실패",
            send_now: "지금 보내기",
            send_now_hint: "지금 응답을 멈추고 바로 보냅니다",
            edit: "대기 메시지 수정",
            remove: "대기 메시지 삭제",
            retry: "다시 작성",
            remove_failed: "실패 메시지 삭제",
            replay: "다시 재생",
            show_more: "더 보기",
            show_less: "접기",
            token: "배포 전에 https://example.com/releases/2026-09-25/artifacts/butler-desktop-universal-build-0123456789abcdef0123456789abcdef/manifest.json?download=true&signature=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 를 확인해 줘.",
            messages: [
                "보내기 전에 최종 보고서에 스크린샷을 추가해 줘.",
                "MCP 비밀 값은 계속 가려진다는 점도 적어 줘.",
                "그다음 초안 PR을 열어 줘.",
            ],
            long: "마이그레이션이 끝나면 375와 1440에서 레이아웃 스모크를 다시 돌리고 어제 스크린샷과 비교해서, 높이가 2픽셀 넘게 바뀐 행을 담당 컴포넌트와 함께 전부 정리해 줘. 사이드바에서 움직인 게 있으면 거기서 멈추고 토큰을 건드리기 전에 먼저 물어봐.",
            sent: "모션 시스템을 요약해 줘.",
            position: |position, total| format!("대기 중 · {total}개 중 {position}번째"),
        },
    )
}

/// `ShowcaseQueued`: the copy and no-op handlers.
fn queued(
    id: String,
    c: &Copy,
    text: impl Into<SharedString>,
    status: impl Into<SharedString>,
    first: bool,
    tone: QueuedTone,
) -> QueuedMessage {
    let failed = tone == QueuedTone::Failed;
    let mut message = QueuedMessage::new(id, text, status)
        .tone(tone)
        .on_edit(if failed { c.retry } else { c.edit }, |_, _, _| {})
        .on_delete(
            if failed { c.remove_failed } else { c.remove },
            |_, _, _| {},
        )
        .clamp(c.show_more, c.show_less);
    if first && !failed {
        message = message.send_now(c.send_now, Some(c.send_now_hint.into()), |_, _, _| {});
    }
    message
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Single",
            render: single,
        },
        Story {
            name: "Several with positions",
            render: several,
        },
        Story {
            name: "Long text",
            render: long_text,
        },
        Story {
            name: "Long unbroken token",
            render: long_token,
        },
        Story {
            name: "Editing",
            render: editing,
        },
        Story {
            name: "Send now",
            render: |lang, window, cx| transition(lang, true, window, cx),
        },
        Story {
            name: "Delivery",
            render: |lang, window, cx| transition(lang, false, window, cx),
        },
        Story {
            name: "Failed",
            render: failed,
        },
    ]
}

fn single(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    queued(
        "qm-single".into(),
        &c,
        c.messages[0],
        c.queued,
        true,
        QueuedTone::Queued,
    )
    .into_any_element()
}

fn long_text(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let text = format!("{}\n\n{}", c.long, c.long);
    queued(
        "qm-long".into(),
        &c,
        text,
        c.queued,
        true,
        QueuedTone::Queued,
    )
    .into_any_element()
}

fn long_token(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    queued(
        "qm-token".into(),
        &c,
        c.token,
        c.queued,
        true,
        QueuedTone::Queued,
    )
    .into_any_element()
}

fn failed(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    queued(
        "qm-failed".into(),
        &c,
        c.messages[1],
        c.failed,
        true,
        QueuedTone::Failed,
    )
    .into_any_element()
}

fn several(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let removed = window.use_keyed_state("qm-several-removed", cx, |_, _| Vec::<usize>::new());
    let gone = removed.read(cx).clone();
    let shown: Vec<usize> = (0..3).filter(|index| !gone.contains(index)).collect();
    let total = shown.len();
    let rows = shown.iter().enumerate().map(|(position, index)| {
        let status = if total > 1 {
            (c.position)(position + 1, total)
        } else {
            c.queued.to_owned()
        };
        let on = removed.clone();
        let index = *index;
        queued(
            format!("qm-several-{index}"),
            &c,
            c.messages[index],
            status,
            position == 0,
            QueuedTone::Queued,
        )
        .on_delete(c.remove, move |_, _, cx| {
            on.update(cx, |gone, cx| {
                gone.push(index);
                cx.notify();
            });
        })
    });
    Stack::new()
        .gap(Space::None)
        .children(rows)
        .into_any_element()
}

/// The delivery: the queued bubble resolves into the sent one in place. With `send_now` the row
/// first shows "Sending…" after Send now.
fn transition(lang: Lang, send_now: bool, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let id = if send_now {
        "qm-send-now"
    } else {
        "qm-delivery"
    };
    let begun = window.use_keyed_state(format!("{id}-begun"), cx, move |_, cx| {
        (!send_now).then(|| cx.background_executor().now())
    });
    let sent_at = window.use_keyed_state(format!("{id}-sent"), cx, |_, _| None::<Instant>);
    let run = window.use_keyed_state(format!("{id}-run"), cx, |_, _| 0usize);
    let now = cx.background_executor().now();
    let (after, from) = if send_now {
        (Duration::from_millis(500), *sent_at.read(cx))
    } else {
        (Duration::from_millis(700), *begun.read(cx))
    };
    let elapsed = from.map(|at| now.saturating_duration_since(at));
    let delivered = elapsed.is_some_and(|elapsed| elapsed >= after);
    if let Some(elapsed) = elapsed.filter(|_| !delivered) {
        motion::wake_after(window, cx, after.saturating_sub(elapsed));
    }
    let sending = send_now && from.is_some() && !delivered;
    let row = if delivered {
        MessageRow::new(format!("{id}-delivered-{}", run.read(cx)), Role::User)
            .entering(Entering::Delivered)
            .child(c.messages[0])
            .into_any_element()
    } else {
        let status = if sending { c.sending } else { c.queued };
        let tone = if sending {
            QueuedTone::Sending
        } else {
            QueuedTone::Queued
        };
        let on = sent_at.clone();
        let mut message = queued(
            format!("{id}-queued"),
            &c,
            c.messages[0],
            status,
            false,
            tone,
        );
        if send_now {
            message =
                message.send_now(c.send_now, Some(c.send_now_hint.into()), move |_, _, cx| {
                    on.update(cx, |at, cx| {
                        *at = Some(cx.background_executor().now());
                        cx.notify();
                    });
                });
        }
        message.into_any_element()
    };
    let replay = Button::new(format!("{id}-replay"))
        .size(Size::Sm)
        .variant(Variant::Outline)
        .text(c.replay)
        .on_click(move |_, _, cx| {
            run.update(cx, |run, _| *run += 1);
            sent_at.update(cx, |at, _| *at = None);
            begun.update(cx, |at, cx| {
                *at = (!send_now).then(|| cx.background_executor().now());
                cx.notify();
            });
        });
    Stack::new()
        .gap(Space::Md)
        .child(super::probe(format!("{id}-delivered-{delivered}")))
        .child(
            Stack::new()
                .gap(Space::None)
                .child(MessageRow::new(format!("{id}-sent-row"), Role::User).child(c.sent))
                .child(row),
        )
        .child(replay)
        .into_any_element()
}

/// Edit moves the queued text back into the composer and removes the row; sending queues it again.
fn editing(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let queued_now = window.use_keyed_state("qm-editing-queued", cx, |_, _| true);
    let draft = window.use_keyed_state("qm-editing-draft", cx, |_, _| SharedString::default());
    let revision = window.use_keyed_state("qm-editing-revision", cx, |_, _| 0_usize);
    let (placeholder, send) = lang.pick(("Ask Butler", "Send"), ("버틀러에게 물어보기", "보내기"));
    let mut stack = Stack::new().gap(Space::Md);
    if *queued_now.read(cx) {
        let (queued_state, draft_state, revision_state) =
            (queued_now.clone(), draft.clone(), revision.clone());
        let text = c.messages[0];
        let row = QueuedMessage::new("qm-editing", text, c.queued)
            .on_edit(c.edit, move |_, _, cx| {
                draft_state.update(cx, |draft, cx| {
                    *draft = text.into();
                    cx.notify();
                });
                revision_state.update(cx, |revision, cx| {
                    *revision += 1;
                    cx.notify();
                });
                queued_state.update(cx, |queued, cx| {
                    *queued = false;
                    cx.notify();
                });
            })
            .on_delete(c.remove, |_, _, _| {})
            .clamp(c.show_more, c.show_less)
            .send_now(c.send_now, Some(c.send_now_hint.into()), |_, _, _| {});
        stack = stack.child(row);
    }
    let seeded = draft.read(cx).clone();
    let key: SharedString = format!("qm-editing-draft-{}", *revision.read(cx)).into();
    let (queued_send, draft_send) = (queued_now, draft);
    let mut field = textarea(ElementId::from(key))
        .placeholder(placeholder)
        .rows(2);
    if !seeded.is_empty() {
        field = field.default_value(seeded);
    }
    let composer = ComposerCard::new("qm-editing-card").child(field).child(
        Toolbar::new()
            .child(ToolbarSpacer)
            .child(
                SendButton::new("qm-editing-send").on_click(move |_, _, cx| {
                    queued_send.update(cx, |queued, cx| {
                        *queued = true;
                        cx.notify();
                    });
                    draft_send.update(cx, |draft, cx| {
                        *draft = SharedString::default();
                        cx.notify();
                    });
                }),
            ),
    );
    let _ = send;
    stack.child(composer).into_any_element()
}
