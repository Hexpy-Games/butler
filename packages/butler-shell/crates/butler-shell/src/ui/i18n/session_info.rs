//! The copy of the session info inspector's context section. Each field names its
//! `packages/butler-i18n` key (`sessionInfo.*`).
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;

pub(crate) struct SessionInfo {
    /// sessionInfo.title, waitingLabel
    pub(crate) title: &'static str,
    pub(crate) waiting_label: &'static str,
    /// taskGraph.title
    pub(crate) task_graph_title: &'static str,
    /// sessionInfo.contextMore, contextLess
    pub(crate) context_more: &'static str,
    pub(crate) context_less: &'static str,
    /// sessionInfo.contextCompactAt, with `{value}` for the token count
    pub(crate) context_compact_at: &'static str,
    /// sessionInfo.contextGroups and contextGroupHints: id, label, hint
    pub(crate) groups: [(&'static str, &'static str, &'static str); 5],
    /// sessionInfo.contextItems: id, label, description
    pub(crate) items: [(&'static str, &'static str, &'static str); 10],
}

const KO: SessionInfo = SessionInfo {
    title: "세션 정보",
    waiting_label: "세션 정보 · 답을 기다리는 요청 있음",
    task_graph_title: "작업 그래프",
    context_more: "자세히",
    context_less: "간단히",
    context_compact_at: "{value}에서 자동 압축",
    groups: [
        ("conversation", "대화", "최근 대화와 방금 보낸 메시지"),
        ("memory", "기억·파일", "불러온 기억과 참조 파일"),
        ("rules", "규칙·설정", "얼, 페르소나, 설정, 규칙"),
        ("base", "기본 정보", "버틀러의 역할과 세션·프로젝트 상태"),
        ("reserve", "예약", "응답·도구·압축용으로 남겨 둔 공간. 사용량에 넣지 않습니다"),
    ],
    items: [
        ("static", "기본 지침", "버틀러의 역할과 고정된 실행 규칙"),
        ("live-config", "규칙·설정", "얼, 페르소나, 설정, 규칙, 프로필"),
        ("runtime-state", "세션 상태", "세션·프로젝트·작업자·과제 상태"),
        ("working", "최근 대화", "최근 대화와 이번 턴의 작업 내용"),
        ("retrieved", "불러온 기억", "기억, 프로젝트 메모리, 최근 압축 요약"),
        ("current-input", "방금 보낸 메시지", "메시지와 첨부 참조"),
        ("references", "참조 파일", "로컬 참조"),
        ("output-reserve", "응답 예약", "답변용으로 남겨 둔 공간"),
        ("tool-reserve", "도구 예약", "도구 호출과 결과용 공간"),
        ("compaction-reserve", "압축 예약", "한도 전에 자동 압축할 공간"),
    ],
};

const EN: SessionInfo = SessionInfo {
    title: "Session info",
    waiting_label: "Session info · Requests awaiting an answer",
    task_graph_title: "Task graph",
    context_more: "Details",
    context_less: "Less",
    context_compact_at: "Auto-compacts at {value}",
    groups: [
        ("conversation", "Conversation", "Recent conversation and your latest message"),
        ("memory", "Memory & files", "Recalled memory and referenced files"),
        ("rules", "Rules & settings", "EOL, persona, settings, rules"),
        ("base", "Basics", "Butler's role and session and project state"),
        ("reserve", "Reserved", "Room kept for replies, tools and compaction. Not counted as used"),
    ],
    items: [
        ("static", "Core instructions", "Butler's role and fixed runtime rules"),
        ("live-config", "Rules & settings", "EOL, persona, settings, rules, profile"),
        ("runtime-state", "Session state", "Session, project, worker and task state"),
        ("working", "Recent conversation", "Recent conversation and this turn's work"),
        ("retrieved", "Recalled memory", "Memory, project memory, latest compaction summary"),
        ("current-input", "Latest message", "Your message and attachment references"),
        ("references", "Referenced files", "Local references"),
        ("output-reserve", "Reply reserve", "Room kept for the reply"),
        ("tool-reserve", "Tool reserve", "Room for tool calls and results"),
        ("compaction-reserve", "Compaction reserve", "Room to auto-compact before the limit"),
    ],
};

impl SessionInfo {
    /// The copy of `lang`.
    pub(crate) fn of(lang: Lang) -> &'static Self {
        match lang {
            Lang::Ko => &KO,
            Lang::En => &EN,
        }
    }

    /// The copy of the app language.
    pub(crate) fn get(cx: &App) -> &'static Self {
        Self::of(Ds::get(cx).lang())
    }
}
