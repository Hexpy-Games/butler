//! Toast.showcase.tsx. The viewer mounts the one `Toaster` at its root (`app.rs`); the stories
//! only raise toasts.
use std::time::Duration;

use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::toast::{self, Action, Toast};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    hint: &'static str,
    success: &'static str,
    saved: &'static str,
    message: &'static str,
    queued: &'static str,
    error: &'static str,
    failed: &'static str,
    loading: &'static str,
    checking: &'static str,
    done: &'static str,
    action: &'static str,
    archived: &'static str,
    undo: &'static str,
    warning: &'static str,
    slow: &'static str,
    burst: &'static str,
    motion: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            hint: "Toasts appear at the top center of the window and dismiss themselves.",
            success: "Show success",
            saved: "Settings saved",
            message: "Show message",
            queued: "Message queued; it sends when the current turn ends.",
            error: "Show error",
            failed: "Could not reach the model provider.",
            loading: "Show loading",
            checking: "Checking for updates…",
            done: "Butler is up to date",
            action: "Show with action",
            archived: "Conversation archived",
            undo: "Undo",
            warning: "Show warning",
            slow: "The model provider is responding slowly.",
            burst: "Show three in a row",
            motion: "Toasts drop in 24px and fade on --motion-enter-overlay (the standard enter curve) and leave on --motion-exit-base; reduced motion only fades.",
        },
        Copy {
            hint: "토스트는 창 위쪽 가운데에 나타나고 스스로 사라집니다.",
            success: "성공 보기",
            saved: "설정을 저장했습니다",
            message: "메시지 보기",
            queued: "메시지를 대기열에 넣었습니다. 현재 작업이 끝나면 보냅니다.",
            error: "오류 보기",
            failed: "모델 제공자에 연결하지 못했습니다.",
            loading: "진행 보기",
            checking: "업데이트를 확인하는 중…",
            done: "버틀러가 최신 버전입니다",
            action: "실행 취소 보기",
            archived: "대화를 보관했습니다",
            undo: "실행 취소",
            warning: "경고 보기",
            slow: "모델 제공자의 응답이 느립니다.",
            burst: "세 개 연달아 보기",
            motion: "토스트는 24px 내려오며 나타나고(--motion-enter-overlay) 더 빨리 사라집니다(--motion-exit-base). 동작 줄이기에서는 페이드만 합니다.",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Tones",
            render: tones,
        },
        Story {
            name: "Motion",
            render: motion,
        },
    ]
}

type Click = Box<dyn Fn(&mut Window, &mut App)>;

/// A small outline Button that runs `click`.
fn trigger(id: &'static str, text: &'static str, click: Click) -> AnyElement {
    Button::new(id)
        .size(Size::Sm)
        .variant(Variant::Outline)
        .text(text)
        .on_click(move |_, window, cx| click(window, cx))
        .into_any_element()
}

/// Runs `then` after `delay` (a `window.setTimeout`).
fn later(window: &mut Window, cx: &mut App, delay: u64, then: impl FnOnce(&mut App) + 'static) {
    window
        .spawn(cx, async move |cx| {
            cx.background_executor()
                .timer(Duration::from_millis(delay))
                .await;
            cx.update(|_, cx| then(cx)).ok();
        })
        .detach();
}

fn tones(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let show = |toast: fn(SharedString) -> Toast, text: &'static str| -> Click {
        Box::new(move |_, cx| {
            toast::show(cx, toast(text.into()));
        })
    };
    let loading: Click = Box::new(move |window, cx| {
        let id = toast::show(cx, Toast::loading(c.checking));
        later(window, cx, 1400, move |cx| {
            toast::show(cx, Toast::success(c.done).id(id));
        });
    });
    let action: Click = Box::new(move |_, cx| {
        toast::show(
            cx,
            Toast::message(c.archived).action(Action::new(c.undo, |_| ())),
        );
    });
    Stack::new()
        .gap(Space::Md)
        .child(Typo::caption(c.hint))
        .child(
            Stack::row()
                .gap(Space::Sm)
                .wrap(true)
                .child(trigger(
                    "toast-success",
                    c.success,
                    show(Toast::success, c.saved),
                ))
                .child(trigger(
                    "toast-message",
                    c.message,
                    show(Toast::message, c.queued),
                ))
                .child(trigger(
                    "toast-error",
                    c.error,
                    show(Toast::error, c.failed),
                ))
                .child(trigger(
                    "toast-warning",
                    c.warning,
                    show(Toast::warning, c.slow),
                ))
                .child(trigger("toast-loading", c.loading, loading))
                .child(trigger("toast-action", c.action, action)),
        )
        .into_any_element()
}

fn motion(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let burst: Click = Box::new(move |window, cx| {
        toast::show(cx, Toast::success(c.saved));
        later(window, cx, 180, move |cx| {
            toast::show(cx, Toast::message(c.queued));
        });
        later(window, cx, 360, move |cx| {
            toast::show(cx, Toast::error(c.failed));
        });
    });
    Stack::new()
        .gap(Space::Md)
        .child(Typo::caption(c.motion))
        .child(trigger("toast-burst", c.burst, burst))
        .into_any_element()
}
