//! `SpanBar.showcaseData.ts`: a Gemini send (429, retry wait, 200 with one tool call to a
//! researcher sub-agent, depth 5), as the showcase's trace.
use butler_ds::ui::blocks::span_bar::SpanTone;
use butler_ds::ui::tag::Tone as TagTone;

use crate::copy::Lang;

/// `(en, ko)`
pub(super) type Pair = (&'static str, &'static str);

pub(super) struct Step {
    pub(super) id: &'static str,
    pub(super) parent: Option<&'static str>,
    pub(super) title: Pair,
    pub(super) offset: f64,
    pub(super) duration: f64,
    /// What the step is; error and wait (status) win over it for the fill.
    pub(super) kind: SpanTone,
    pub(super) problem: Option<SpanTone>,
    pub(super) tag: Option<(Pair, TagTone)>,
    pub(super) facts: &'static [(Pair, Pair)],
}

const fn same(text: &'static str) -> Pair {
    (text, text)
}

const OK: Option<(Pair, TagTone)> = Some((same("200"), TagTone::Neutral));
const LIMITED: Option<(Pair, TagTone)> = Some((same("429"), TagTone::Danger));

/// The whole trace, in ms.
pub(super) const TOTAL: f64 = 9840.;

/// Rows open at first: the turn, the wait, the 200 attempt and the researcher sub-tree.
pub(super) const OPEN: [&str; 7] = [
    "turn", "wait-1", "req-2", "tool", "sub-turn", "sub-tool", "mcp",
];

const fn step(
    id: &'static str,
    parent: Option<&'static str>,
    title: Pair,
    (offset, duration): (f64, f64),
    kind: SpanTone,
) -> Step {
    Step {
        id,
        parent,
        title,
        offset,
        duration,
        kind,
        problem: None,
        tag: None,
        facts: &[],
    }
}

impl Step {
    const fn problem(mut self, problem: SpanTone) -> Self {
        self.problem = Some(problem);
        self
    }

    const fn tag(mut self, tag: Option<(Pair, TagTone)>) -> Self {
        self.tag = tag;
        self
    }

    const fn facts(mut self, facts: &'static [(Pair, Pair)]) -> Self {
        self.facts = facts;
        self
    }

    /// Status first (error red, wait amber), then the step's kind.
    pub(super) fn tone(&self) -> SpanTone {
        self.problem.unwrap_or(self.kind)
    }
}

pub(super) static STEPS: [Step; 20] = [
    step(
        "send",
        None,
        ("Send message", "메시지 보내기"),
        (0., 4.),
        SpanTone::App,
    ),
    step(
        "deliver",
        None,
        ("Deliver", "전달"),
        (4., 18.),
        SpanTone::App,
    ),
    step(
        "turn",
        None,
        ("Run turn", "턴 실행"),
        (22., 9818.),
        SpanTone::Agent,
    )
    .facts(&[
        (("Turn ID", "턴 ID"), same("turn_01JB7Q4M2X")),
        (("Model", "모델"), same("Gemini 3 Pro")),
        (("Retries", "재시도"), ("1", "1회")),
    ]),
    step(
        "route",
        Some("turn"),
        ("Pick model", "모델 선택"),
        (30., 6.),
        SpanTone::Agent,
    )
    .facts(&[(
        ("Large model", "대형 모델"),
        ("Picked · default", "선택 · 기본 모델"),
    )]),
    step(
        "context",
        Some("turn"),
        ("Build context", "컨텍스트 구성"),
        (36., 132.),
        SpanTone::Agent,
    )
    .facts(&[(("Total", "합계"), ("14,050 tokens", "14,050 토큰"))]),
    step(
        "req-1",
        Some("turn"),
        ("Model request 1/3", "모델 요청 1/3"),
        (168., 412.),
        SpanTone::Model,
    )
    .problem(SpanTone::Error)
    .tag(LIMITED)
    .facts(&[
        (
            ("Result", "결과"),
            ("429 Rate limited", "429 요청 한도 초과"),
        ),
        (("Next", "다음"), ("Retry in 2s", "2초 대기 후 재시도")),
    ]),
    step(
        "http-1",
        Some("req-1"),
        ("HTTP request", "HTTP 요청"),
        (170., 408.),
        SpanTone::Model,
    )
    .problem(SpanTone::Error)
    .tag(LIMITED)
    .facts(&[(("Request ID", "요청 ID"), same("9c1e0a7f2b4d"))]),
    step(
        "wait-1",
        Some("turn"),
        ("Retry wait", "재시도 대기"),
        (580., 2000.),
        SpanTone::Agent,
    )
    .problem(SpanTone::Wait)
    .tag(Some((("Wait", "대기"), TagTone::Warning)))
    .facts(&[
        (same("retry-after"), ("2s", "2초")),
        (("Policy", "정책"), ("Up to 3", "최대 3회")),
        (("Reason", "이유"), same("RESOURCE_EXHAUSTED")),
    ]),
    step(
        "req-2",
        Some("turn"),
        ("Model request 2/3", "모델 요청 2/3"),
        (2580., 3150.),
        SpanTone::Model,
    )
    .tag(OK)
    .facts(&[
        (("Attempt", "시도"), same("2/3")),
        (
            ("Result", "결과"),
            ("200 · 1 tool call", "200 · 도구 호출 1개"),
        ),
    ]),
    step(
        "http-2",
        Some("req-2"),
        ("HTTP request", "HTTP 요청"),
        (2582., 3146.),
        SpanTone::Model,
    )
    .tag(OK)
    .facts(&[(("First byte", "첫 바이트"), ("1.08s", "1.08초"))]),
    step(
        "stream",
        Some("http-2"),
        ("Receive stream", "스트림 수신"),
        (3662., 2066.),
        SpanTone::Model,
    )
    .facts(&[(("Chunks", "청크"), ("31", "31개"))]),
    step(
        "tool",
        Some("turn"),
        ("Tool call · ask_researcher", "도구 호출 · ask_researcher"),
        (5740., 3720.),
        SpanTone::Tool,
    )
    .facts(&[(
        ("Tool", "도구"),
        (
            "ask_researcher (sub-agent)",
            "ask_researcher (하위 에이전트)",
        ),
    )]),
    step(
        "sub-turn",
        Some("tool"),
        ("Sub-turn · Researcher", "하위 턴 실행 · 리서처"),
        (5752., 3690.),
        SpanTone::Agent,
    )
    .facts(&[(("Model", "모델"), ("Fast model", "빠른 모델"))]),
    step(
        "sub-req",
        Some("sub-turn"),
        ("Model request 1/3", "모델 요청 1/3"),
        (5760., 352.),
        SpanTone::Model,
    )
    .tag(OK)
    .facts(&[(
        ("Result", "결과"),
        ("Tool call docs.search", "도구 호출 docs.search"),
    )]),
    step(
        "sub-tool",
        Some("sub-turn"),
        ("Tool call · docs.search", "도구 호출 · docs.search"),
        (6120., 2410.),
        SpanTone::Tool,
    )
    .facts(&[(("Tool", "도구"), same("docs.search (MCP)"))]),
    step(
        "mcp",
        Some("sub-tool"),
        ("MCP call · tools/call", "MCP 호출 · tools/call"),
        (6126., 2398.),
        SpanTone::Tool,
    )
    .facts(&[(("Server", "서버"), same("docs"))]),
    step(
        "mcp-http",
        Some("mcp"),
        same("MCP HTTP · POST /mcp"),
        (6131., 2380.),
        SpanTone::Tool,
    )
    .tag(OK)
    .facts(&[
        (same("URL"), same("http://127.0.0.1:8931/mcp")),
        (
            ("Response", "응답"),
            ("18.2 KB · 6 results", "18.2 KB · 결과 6개"),
        ),
    ]),
    step(
        "sub-final",
        Some("sub-turn"),
        ("Model request (tool result)", "모델 요청 (도구 결과)"),
        (8540., 890.),
        SpanTone::Model,
    )
    .tag(OK)
    .facts(&[(("Finish", "종료 이유"), same("stop"))]),
    step(
        "final",
        Some("turn"),
        ("Model request (tool result)", "모델 요청 (도구 결과)"),
        (9470., 330.),
        SpanTone::Model,
    )
    .tag(OK)
    .facts(&[(("Finish", "종료 이유"), same("STOP"))]),
    step(
        "memory",
        Some("turn"),
        ("Save memory", "기억 저장"),
        (9800., 40.),
        SpanTone::Agent,
    )
    .facts(&[(("Items", "항목"), ("2", "2개"))]),
];

pub(super) fn find(id: &str) -> Option<&'static Step> {
    STEPS.iter().find(|step| step.id == id)
}

/// How many levels below a root the step sits.
pub(super) fn depth(step: &Step) -> u32 {
    let mut depth = 0;
    let mut parent = step.parent;
    while let Some(next) = parent.and_then(find) {
        depth += 1;
        parent = next.parent;
    }
    depth
}

pub(super) fn children(id: &str) -> impl Iterator<Item = &'static Step> + '_ {
    STEPS.iter().filter(move |step| step.parent == Some(id))
}

/// "412ms" under a second, else "2.58s" / "2.58초"; whole seconds drop the decimals
/// (`formatTraceMs`).
pub(super) fn format_ms(lang: Lang, ms: f64) -> String {
    if ms > 0. && ms < 1000. {
        return format!("{}ms", ms.round());
    }
    let seconds: f64 = format!("{:.2}", ms / 1000.).parse().unwrap_or_default();
    lang.pick(format!("{seconds}s"), format!("{seconds}초"))
}

/// "+0.58s" (`startText`).
pub(super) fn start_text(lang: Lang, offset: f64) -> String {
    let seconds = offset / 1000.;
    lang.pick(format!("+{seconds:.2}s"), format!("+{seconds:.2}초"))
}
