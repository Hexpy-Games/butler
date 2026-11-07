//! Harness-only data: an in-memory [`Source`] with a handful of chats, one long conversation,
//! one chat waiting on a command approval and one on a question.
use std::time::{SystemTime, UNIX_EPOCH};

use futures::FutureExt as _;
use futures::StreamExt as _;
use futures::stream::LocalBoxStream;

use crate::ui::source::model::{Access, Operation};
use crate::ui::source::wire::SessionView;
use crate::ui::source::{
    Approval, AuthorityCard, CardKind, ChatId, ChatPage, ChatRef, ChatSummary, Decision,
    EventCursor, Fetch, LiveEvent, PageCursor, RequestRef, Risk, SessionId, Source, SourceError,
    Space, Timestamp, TurnId,
};

pub(super) const LONG: &str = "c-long";
pub(super) const APPROVAL: &str = "c-approval";
pub(super) const QUESTION: &str = "c-question";

fn space(id: &str, title: &str, project: bool) -> Space {
    Space {
        id: id.to_owned().into(),
        title: title.to_owned().into(),
        project,
    }
}

fn chat_ref(id: &str) -> ChatRef {
    ChatRef {
        chat: ChatId(id.to_owned().into()),
        session: SessionId(format!("s-{id}").into()),
    }
}

/// `minutes` ago.
fn ago(minutes: i64) -> Timestamp {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    Timestamp(i64::try_from(now).unwrap_or(0) - minutes * 60_000)
}

fn chat(
    id: &str,
    title: &str,
    space: Option<Space>,
    pinned: bool,
    running: bool,
    minutes: i64,
) -> ChatSummary {
    ChatSummary {
        waiting: false,
        chat: chat_ref(id),
        title: title.to_owned().into(),
        space,
        pinned,
        archived: false,
        created_at: Timestamp(0),
        running,
        updated_at: ago(minutes),
    }
}

fn chats() -> Vec<ChatSummary> {
    let work = || Some(space("s-work", "업무", false));
    let butler = || Some(space("s-butler", "butler", true));
    vec![
        chat(LONG, "gpui 이식 검토 — 긴 대화", butler(), true, false, 2),
        chat(APPROVAL, "배포 스크립트 점검", butler(), false, true, 9),
        chat(
            QUESTION,
            "Release notes for preview.14",
            butler(),
            false,
            false,
            50,
        ),
        chat("c-weekly", "주간 업무 보고 정리", work(), true, false, 35),
        chat("c-reply", "고객 문의 답변 초안", work(), false, false, 40),
        chat("c-okr", "Q4 OKR 회고", work(), false, false, 300),
        chat("c-meeting", "거래처 미팅 메모", work(), false, false, 420),
        chat("c-today", "오늘 할 일", None, false, false, 12),
        chat("c-rust", "Rust lifetime 질문", None, false, false, 70),
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

/// One wire message record of `session`.
fn message(id: &str, role: &str, text: &str, cursor: usize) -> serde_json::Value {
    serde_json::json!({"id": id, "chat_id": format!("s-{LONG}"), "role": role, "text": text,
        "status": "delivered", "cursor": cursor,
        "created_at": "2026-01-01T10:00:00Z", "updated_at": "2026-01-01T10:00:00Z"})
}

fn long_chat() -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for i in 0..12 {
        out.push(message(&format!("m{i}u"), "user", USER_LINES[i % 3], 2 * i));
        out.push(message(
            &format!("m{i}a"),
            "assistant",
            REPLIES[i % 3],
            2 * i + 1,
        ));
    }
    out
}

fn approval_chat() -> Vec<serde_json::Value> {
    let mut reply = message(
        "a1",
        "assistant",
        "release 빌드를 실행하려면 명령 실행 승인이 필요합니다.",
        1,
    );
    reply["status"] = "streaming".into();
    vec![
        message(
            "a0",
            "user",
            "배포 전에 release 빌드가 깨지지 않는지 한 번 돌려 주세요.",
            0,
        ),
        reply,
    ]
}

/// The session view of `session` with its messages and running turn.
fn view(session: &SessionId) -> Result<SessionView, SourceError> {
    let messages = match session.0.as_ref() {
        "s-c-long" => long_chat(),
        "s-c-approval" => approval_chat(),
        _ => Vec::new(),
    };
    let turn = (session.0.as_ref() == "s-c-approval").then(|| {
        serde_json::json!({"id": "t-approval", "state": "waiting_for_tool", "cancellable": true,
            "retryable": false, "created_at": "2026-01-01T10:00:00Z",
            "updated_at": "2026-01-01T10:00:00Z"})
    });
    let count = messages.len();
    let view = serde_json::json!({
        "session_id": session.0.as_ref(), "kind": "chat", "status": "active",
        "active_turn": turn, "messages": messages,
        "message_window": {"next_cursor": count, "complete": true},
        "cursors": {"messages": count, "events": 1},
        "generated_at": "2026-01-01T10:00:00Z", "updated_at": "2026-01-01T10:00:00Z"
    });
    serde_json::from_value(view).map_err(|_| SourceError::Missing)
}

fn command_card() -> AuthorityCard {
    let command = "cargo build --release -p butler-agent --target-dir /tmp/butler-release-check --message-format short";
    AuthorityCard {
        request: RequestRef("r-1".into()),
        kind: CardKind::Command,
        reason: "배포 전에 release 빌드가 깨지지 않는지 확인합니다.".into(),
        approval: Some(Approval {
            wire: None,
            action_kind: "command".into(),
            operation: Some(Operation {
                tool: "shell".into(),
                access: Access::Change,
                targets: Vec::new(),
                command: Some(command.into()),
            }),
            targets: Vec::new(),
            count: 1,
            examples: vec![command.into()],
            examples_truncated: vec![false],
            risk: Some(Risk::Medium),
        }),
    }
}

fn question_card() -> AuthorityCard {
    AuthorityCard {
        request: RequestRef("r-2".into()),
        kind: CardKind::Question,
        reason: "릴리스 노트를 어느 브랜치 기준으로 쓸까요?".into(),
        approval: None,
    }
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
            events: EventCursor(1),
        })
    }

    fn open_session(&self, session: &SessionId) -> Fetch<SessionView> {
        futures::future::ready(view(session)).boxed_local()
    }

    fn session_view(&self, session: &SessionId, _: Option<String>) -> Fetch<SessionView> {
        futures::future::ready(view(session)).boxed_local()
    }

    fn authority(&self, session: &SessionId) -> Fetch<Vec<AuthorityCard>> {
        let cards = match session.0.as_ref() {
            "s-c-approval" => vec![command_card()],
            "s-c-question" => vec![question_card()],
            _ => Vec::new(),
        };
        ready(cards)
    }

    fn live(&self, _: EventCursor) -> LocalBoxStream<'static, LiveEvent> {
        futures::stream::pending().boxed_local()
    }

    fn create_chat(&self) -> Fetch<ChatRef> {
        ready(chat_ref("c-new"))
    }

    fn cancel(&self, _: &TurnId) -> Fetch<()> {
        ready(())
    }

    fn answer(&self, _: &SessionId, _: &RequestRef, _: Decision) -> Fetch<()> {
        ready(())
    }
}
