//! Harness-only data: an in-memory [`Source`] with a handful of chats, one long conversation,
//! one chat waiting on a command approval and one on a question.
use std::time::{SystemTime, UNIX_EPOCH};

use futures::FutureExt as _;
use futures::StreamExt as _;
use futures::stream::LocalBoxStream;

use crate::ui::source::model::{Access, Operation, ToolChip};
use crate::ui::source::{
    ActivityItem, Approval, AuthorityCard, CardKind, ChatId, ChatPage, ChatRef, ChatSummary,
    ClientMessageId, ComposerContext, Decision, EventCursor, Fetch, LiveEvent, Message,
    MessageCursor, MessagePage, PageCursor, RequestRef, Risk, Role, SentTurn, SessionId, Source,
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
        chat: chat_ref(id),
        title: title.to_owned().into(),
        space,
        pinned,
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

fn message(id: String, role: Role, text: &str) -> Message {
    Message {
        id: id.into(),
        role,
        text: text.to_owned(),
        activity: Vec::new(),
        streaming: false,
    }
}

fn tool(icon: &'static str, title: &str) -> ToolChip {
    ToolChip {
        icon,
        title: title.to_owned().into(),
    }
}

fn long_chat() -> Vec<Message> {
    let mut out = Vec::new();
    for i in 0..12 {
        out.push(message(format!("m{i}u"), Role::User, USER_LINES[i % 3]));
        let mut reply = message(format!("m{i}a"), Role::Assistant, REPLIES[i % 3]);
        if i == 11 {
            reply.activity = vec![
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
            ];
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
    reply.streaming = true;
    reply.activity = vec![ActivityItem {
        title: "빌드 명령 준비".into(),
        tools: vec![tool("terminal", "cargo build --release -p butler-agent")],
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

fn command_card() -> AuthorityCard {
    let command = "cargo build --release -p butler-agent --target-dir /tmp/butler-release-check --message-format short";
    AuthorityCard {
        request: RequestRef("r-1".into()),
        kind: CardKind::Command,
        reason: "배포 전에 release 빌드가 깨지지 않는지 확인합니다.".into(),
        approval: Some(Approval {
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

    fn messages(&self, session: &SessionId, _: Option<MessageCursor>) -> Fetch<MessagePage> {
        let messages = match session.0.as_ref() {
            "s-c-long" => long_chat(),
            "s-c-approval" => approval_chat(),
            _ => Vec::new(),
        };
        let running = (session.0.as_ref() == "s-c-approval").then(|| TurnId("t-approval".into()));
        ready(MessagePage {
            messages,
            older: None,
            running,
            events: EventCursor(1),
        })
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

    fn send(&self, _: &ChatId, _: ClientMessageId, _: String) -> Fetch<SentTurn> {
        ready(SentTurn {
            turn: TurnId("t-new".into()),
        })
    }

    fn cancel(&self, _: &TurnId) -> Fetch<()> {
        ready(())
    }

    fn answer(&self, _: &SessionId, _: &RequestRef, _: Decision) -> Fetch<()> {
        ready(())
    }

    fn composer(&self) -> ComposerContext {
        ComposerContext {
            permission: "먼저 확인".into(),
            model: "Luna".into(),
            effort: "중간".into(),
        }
    }
}
