//! Notice.showcase.tsx: tones, error with retry, missing resource, single line, multi-line
//! warning, neutral status and the inline save result.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::success_check::SuccessCheck;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    saved: &'static str,
    slow: &'static str,
    created: &'static str,
    failed: &'static str,
    retry_hint: &'static str,
    retry: &'static str,
    missing: &'static str,
    missing_help: &'static str,
    new_chat: &'static str,
    loading: &'static str,
    history: &'static str,
    waiting: &'static str,
    reopen: &'static str,
    account: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            saved: "Settings saved",
            slow: "The model provider is responding slowly.",
            created: "Project created",
            failed: "Could not load the dashboard",
            retry_hint: "Check the connection and try again.",
            retry: "Retry",
            missing: "This project no longer exists",
            missing_help: "It may have been removed on another device. Start a new chat instead.",
            new_chat: "New chat",
            loading: "Loading the dashboard…",
            history: "Project history is unavailable right now.",
            waiting: "Waiting for your browser",
            reopen: "Open browser again",
            account: "Signed in as ada@example.com",
        },
        Copy {
            saved: "설정을 저장했습니다",
            slow: "모델 제공자의 응답이 느립니다.",
            created: "프로젝트를 만들었습니다",
            failed: "대시보드를 불러오지 못했습니다",
            retry_hint: "연결을 확인하고 다시 시도하세요.",
            retry: "다시 시도",
            missing: "이 프로젝트가 더 이상 없습니다",
            missing_help: "다른 기기에서 삭제되었을 수 있습니다. 새 채팅을 시작하세요.",
            new_chat: "새 채팅",
            loading: "대시보드를 불러오는 중…",
            history: "지금은 프로젝트 기록을 볼 수 없습니다.",
            waiting: "브라우저에서 기다리는 중",
            reopen: "브라우저 다시 열기",
            account: "ada@example.com 계정으로 로그인함",
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
            name: "Error with retry",
            render: error_retry,
        },
        Story {
            name: "Missing resource",
            render: missing,
        },
        Story {
            name: "Single-line with icon and action",
            render: single_line,
        },
        Story {
            name: "Multi-line warning (first-line icon)",
            render: multi_line,
        },
        Story {
            name: "Neutral status",
            render: neutral,
        },
        Story {
            name: "Inline save result",
            render: save_result,
        },
    ]
}

fn glyph(glyph: Icon, cx: &App) -> impl gpui::IntoElement + use<> {
    icon(glyph, IconSize::Md, Ds::get(cx))
}

fn outline(id: &'static str, text: &'static str, size: Size) -> Button {
    Button::new(id)
        .variant(Variant::Outline)
        .size(size)
        .text(text)
}

fn tones(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Sm)
        .child(
            Notice::new(NoticeTone::Neutral, c.waiting).icon(Spinner::new("notice-spin").size(14.)),
        )
        .child(Notice::new(NoticeTone::Info, c.loading).icon(glyph(Icon::AlertCircle, cx)))
        .child(Notice::new(NoticeTone::Warning, c.slow).icon(glyph(Icon::AlertCircle, cx)))
        .child(Notice::new(NoticeTone::Success, c.created).icon(glyph(Icon::CheckCircle2, cx)))
        .child(Notice::new(NoticeTone::Error, c.history).icon(glyph(Icon::CircleX, cx)))
        .into_any_element()
}

fn error_retry(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Notice::new(NoticeTone::Error, c.retry_hint)
        .title(c.failed)
        .action(outline("notice-retry", c.retry, Size::Default))
        .into_any_element()
}

fn missing(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Notice::new(NoticeTone::Info, c.missing_help)
        .title(c.missing)
        .action(outline("notice-new-chat", c.new_chat, Size::Default))
        .into_any_element()
}

fn single_line(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    Notice::new(NoticeTone::Info, c.saved)
        .icon(glyph(Icon::AlertCircle, cx))
        .action(outline("notice-single-retry", c.retry, Size::Default))
        .into_any_element()
}

fn multi_line(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    Notice::new(NoticeTone::Warning, c.missing_help)
        .icon(glyph(Icon::AlertCircle, cx))
        .into_any_element()
}

fn neutral(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Sm)
        .child(
            Notice::new(NoticeTone::Neutral, c.waiting)
                .icon(Spinner::new("notice-neutral-spin").size(14.))
                .action(outline("notice-reopen", c.reopen, Size::Sm)),
        )
        .child(
            Notice::new(NoticeTone::Neutral, c.account).icon(
                SuccessCheck::new("notice-account")
                    .size(16.)
                    .ring()
                    .animate_if(false),
            ),
        )
        .into_any_element()
}

fn save_result(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Notice::new(NoticeTone::Success, copy(lang).saved).into_any_element()
}
