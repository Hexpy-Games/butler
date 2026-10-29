//! Harness-only data: an in-memory [`Source`] with a handful of chats, one long conversation,
//! one chat waiting on an authority request, and the schedule dialog from the glass spike.
use futures::FutureExt as _;
use futures::StreamExt as _;
use futures::stream::LocalBoxStream;
use gpui::{AnyElement, FontWeight, SharedString, div, prelude::*, px};

use crate::dialog::DialogSpec;
use crate::glass::{self, Native};
use crate::source::{
    ActivityItem, AuthorityCard, ChatId, ChatPage, ChatSummary, ComposerContext, Decision, Fetch,
    LiveUpdate, Message, MessageCursor, MessagePage, PageCursor, Role, SentTurn, Source, Space,
    TurnId, model::ToolChip,
};
use crate::theme::Theme;
use crate::widgets::{icon, text};

pub(super) const LONG: &str = "c-long";
pub(super) const APPROVAL: &str = "c-approval";

fn space(id: &str, title: &str, project: bool) -> Option<Space> {
    Some(Space {
        id: id.to_owned().into(),
        title: title.to_owned().into(),
        project,
    })
}

fn chat(
    id: &str,
    title: &str,
    space: Option<Space>,
    pinned: bool,
    running: bool,
    age: &str,
) -> ChatSummary {
    ChatSummary {
        id: ChatId(id.to_owned().into()),
        title: title.to_owned().into(),
        space,
        pinned,
        running,
        age: age.to_owned().into(),
    }
}

fn chats() -> Vec<ChatSummary> {
    let work = || space("s-work", "업무", false);
    let butler = || space("s-butler", "butler", true);
    vec![
        chat(
            LONG,
            "gpui 이식 검토 — 긴 대화",
            butler(),
            true,
            false,
            "2분 전",
        ),
        chat(
            APPROVAL,
            "배포 스크립트 점검",
            butler(),
            false,
            true,
            "9분 전",
        ),
        chat(
            "c-weekly",
            "주간 업무 보고 정리",
            work(),
            true,
            false,
            "35분 전",
        ),
        chat(
            "c-release",
            "Release notes for preview.14",
            butler(),
            false,
            false,
            "50분 전",
        ),
        chat(
            "c-reply",
            "고객 문의 답변 초안",
            work(),
            false,
            false,
            "40분 전",
        ),
        chat("c-okr", "Q4 OKR 회고", work(), false, false, "5시간 전"),
        chat(
            "c-meeting",
            "거래처 미팅 메모",
            work(),
            false,
            false,
            "7시간 전",
        ),
        chat("c-today", "오늘 할 일", None, false, false, "12분 전"),
        chat(
            "c-rust",
            "Rust lifetime 질문",
            None,
            false,
            false,
            "1시간 전",
        ),
    ]
}

const USER_LINES: [&str; 3] = [
    "브라우저 패널을 열었을 때 채팅 폭이 400px로 유지되는지 확인해 주세요.",
    "한글 입력할 때 조합 중인 글자가 밑줄로 보이는지도 봐 주세요.",
    "좋아요. 다크 모드에서 글래스 대비도 같이 확인해 주세요.",
];

const REPLIES: [&str; 3] = [
    "## 요약\n\ngpui 프로토타입은 **WebView2 자식 창**과 함께 띄워도 60fps를 유지했습니다.\n\n- 한글 줄바꿈: gpui는 음절 단위로 줄을 바꿉니다.\n- 포커스 링은 컴포넌트마다 직접 그려야 합니다.",
    "### 확인 결과\n\n조합 중인 글자는 **밑줄**로 표시되고, 조합이 끝나기 전에는 Enter가 전송되지 않습니다.\n\n```rust\nfn main() {\n    let app = gpui_platform::application(); // 30ms\n}\n```",
    "다크 모드 글래스는 중앙이 `rgba(23, 24, 26, 1)`로 불투명합니다.\n\n| 항목 | 값 |\n|---|---|\n| 메시지 | 320개 |\n| 목표 | 60fps |",
];

fn message(id: String, role: Role, text: &str) -> Message {
    Message {
        id: id.into(),
        role,
        text: text.to_owned(),
        activity: Vec::new(),
        streaming: false,
    }
}

fn activity() -> Vec<ActivityItem> {
    let tool = |icon, title: &str| ToolChip {
        icon,
        title: title.to_owned().into(),
    };
    vec![
        ActivityItem {
            title: "저장소 구조 확인".into(),
            tools: vec![tool("terminal", "rg --files packages/butler-app/client/ui")],
        },
        ActivityItem {
            title: "디자인 토큰 읽기".into(),
            tools: vec![tool("file", "tokens.css 읽기")],
        },
        ActivityItem {
            title: "비교표 작성".into(),
            tools: Vec::new(),
        },
    ]
}

fn long_chat() -> Vec<Message> {
    let mut out = Vec::new();
    for i in 0..12 {
        out.push(message(format!("m{i}u"), Role::User, USER_LINES[i % 3]));
        let mut reply = message(format!("m{i}a"), Role::Assistant, REPLIES[i % 3]);
        if i == 11 {
            reply.activity = activity();
        }
        out.push(reply);
    }
    out
}

fn approval_chat() -> Vec<Message> {
    let mut reply = message(
        "a1".into(),
        Role::Assistant,
        "release 빌드를 실행하려면 명령 실행 승인이 필요합니다.",
    );
    reply.activity = vec![ActivityItem {
        title: "빌드 명령 준비".into(),
        tools: vec![ToolChip {
            icon: "terminal",
            title: "cargo build --release -p butler-agent".into(),
        }],
    }];
    vec![
        message(
            "a0".into(),
            Role::User,
            "배포 전에 release 빌드가 깨지지 않는지 한 번 돌려 주세요.",
        ),
        reply,
    ]
}

/// The in-memory agent.
pub(super) struct Fixture;

fn ready<T: 'static>(value: T) -> Fetch<T> {
    futures::future::ready(Ok(value)).boxed_local()
}

impl Source for Fixture {
    fn chats(&self, _: Option<PageCursor>) -> Fetch<ChatPage> {
        ready(ChatPage {
            chats: chats(),
            next: None,
        })
    }

    fn messages(&self, chat: &ChatId, _: Option<MessageCursor>) -> Fetch<MessagePage> {
        let messages = match chat.0.as_ref() {
            LONG => long_chat(),
            APPROVAL => approval_chat(),
            _ => Vec::new(),
        };
        let running = (chat.0.as_ref() == APPROVAL).then(|| TurnId("t-approval".into()));
        ready(MessagePage {
            messages,
            older: None,
            running,
        })
    }

    fn authority(&self, chat: &ChatId) -> Fetch<Vec<AuthorityCard>> {
        let cards = (chat.0.as_ref() == APPROVAL).then(|| AuthorityCard {
            request: "r-1".into(),
            kind: "권한".into(),
            action: "cargo build --release -p butler-agent".into(),
            details: vec![
                "butler 프로젝트 폴더에서 이 명령 실행".into(),
                "네트워크 사용 없음 · 예상 시간 2분".into(),
            ],
            risk: Some("위험 보통".into()),
        });
        ready(cards.into_iter().collect())
    }

    fn live(&self) -> LocalBoxStream<'static, LiveUpdate> {
        futures::stream::pending().boxed_local()
    }

    fn send(&self, chat: Option<ChatId>, _: String) -> Fetch<SentTurn> {
        ready(SentTurn {
            chat: chat.unwrap_or(ChatId("c-new".into())),
            turn: TurnId("t-new".into()),
        })
    }

    fn cancel(&self, _: TurnId) -> Fetch<()> {
        ready(())
    }

    fn answer(&self, _: String, _: Decision) -> Fetch<()> {
        ready(())
    }

    fn composer(&self) -> ComposerContext {
        ComposerContext {
            permission: "먼저 확인".into(),
            model: "GPT-6 Luna".into(),
            effort: "중간".into(),
        }
    }
}

/// One label-value row of the schedule table.
fn row(label: &'static str, value: AnyElement, t: &Theme, s: f32) -> AnyElement {
    div()
        .h(px(38. * s))
        .flex()
        .items_center()
        .border_t_1()
        .border_color(t.line)
        .child(div().w(px(84. * s)).flex_none().child(text(
            label,
            (13. * s, 18. * s),
            FontWeight::NORMAL,
            t.text2,
        )))
        .child(value)
        .into_any_element()
}

/// The repeat select: a glass control on the dialog's glass.
fn select(t: &Theme, s: f32) -> AnyElement {
    div()
        .relative()
        .h(px(30. * s))
        .px(px(12. * s))
        .flex()
        .items_center()
        .gap(px(6. * s))
        .child(glass::layer(t, 15. * s, Native::on_glass(0., 0.)))
        .child(text(
            "매주 월요일",
            (14. * s, 20. * s),
            FontWeight::MEDIUM,
            t.text,
        ))
        .child(icon("chevron-down", 14. * s, t.text2))
        .into_any_element()
}

/// The glass spike's schedule dialog (520 x 360).
pub(super) fn schedule_dialog() -> DialogSpec {
    let body = |t: &Theme, s: f32| {
        let value = |v: &'static str| {
            text(v, (14. * s, 20. * s), FontWeight::NORMAL, t.text).into_any_element()
        };
        let table = div()
            .mt(px(14. * s))
            .flex()
            .flex_col()
            .child(row("이름", value("주간 보고서 정리"), t, s))
            .child(row("시작", value("10월 28일 (화) 오전 9:00"), t, s))
            .child(row("반복", select(t, s), t, s))
            .child(row("권한", value("알아서 진행"), t, s));
        div()
            .flex()
            .flex_col()
            .child(text(
                "매주 월요일 아침, 지난주 대화를 정리해 보고서로 남깁니다.",
                (14. * s, 20. * s),
                FontWeight::NORMAL,
                t.text,
            ))
            .child(text(
                "실행할 때마다 확인을 묻지 않고 알아서 진행합니다.",
                (13. * s, 18. * s),
                FontWeight::NORMAL,
                t.text2,
            ))
            .child(table)
            .into_any_element()
    };
    DialogSpec {
        title: SharedString::from("예약 작업 만들기"),
        leading: Some(("back", "arrow-left")),
        trailing: vec![("more", "more"), ("close", "x")],
        body: Box::new(body),
        actions: vec![("cancel", "취소", false), ("create", "만들기", true)],
        size: (520., 360.),
    }
}
