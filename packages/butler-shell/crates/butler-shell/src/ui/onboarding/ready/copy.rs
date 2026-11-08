//! The finish step's copy. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// firstRun.finishing
    pub(super) finishing: &'static str,
    /// firstRun.doneTitle
    pub(super) done_title: &'static str,
    /// firstRun.doneBody
    pub(super) done_body: &'static str,
    /// firstRun.finish
    pub(super) finish: &'static str,
    /// firstRun.summary.{rowAi, rowReply, rowAgents}
    pub(super) rows: [&'static str; 3],
    /// firstRun.summary.agentCounts
    pub(super) agent_counts: fn(u64, u64) -> String,
    /// firstRun.planNotice
    pub(super) plan_notice: &'static str,
    /// chatgptPlan.manageUsage
    pub(super) manage_usage: &'static str,
    /// firstRun.providerNames, in `CardId` order
    pub(super) providers: [&'static str; 11],
}

fn agent_counts_ko(instructions: u64, servers: u64) -> String {
    let parts = [
        (instructions > 0).then(|| format!("지침 {instructions}개")),
        (servers > 0).then(|| format!("MCP 서버 {servers}개")),
    ];
    parts.into_iter().flatten().collect::<Vec<_>>().join(" · ")
}

fn agent_counts_en(instructions: u64, servers: u64) -> String {
    let plural = |n: u64| if n == 1 { "" } else { "s" };
    let parts = [
        (instructions > 0).then(|| format!("{instructions} instruction{}", plural(instructions))),
        (servers > 0).then(|| format!("{servers} MCP server{}", plural(servers))),
    ];
    parts.into_iter().flatten().collect::<Vec<_>>().join(" · ")
}

const KO: Words = Words {
    finishing: "버틀러 준비가 끝나면 바로 시작합니다",
    done_title: "준비를 마쳤습니다",
    done_body: "설정에서 언제든 바꿀 수 있습니다.",
    finish: "시작하기",
    rows: ["AI", "답변 언어", "AI 도구"],
    agent_counts: agent_counts_ko,
    plan_notice: "버틀러의 AI 요청에 ChatGPT 플랜이 쓰입니다.",
    manage_usage: "사용량 관리",
    providers: [
        "ChatGPT",
        "Claude",
        "Gemini",
        "OpenAI API",
        "Grok",
        "Qwen",
        "Kimi",
        "Z.AI 코딩 플랜",
        "Z.AI API",
        "OpenCode Go",
        "기타 (OpenAI 호환)",
    ],
};

const EN: Words = Words {
    finishing: "Starting as soon as Butler is ready",
    done_title: "You're all set",
    done_body: "You can change any of this in Settings.",
    finish: "Get started",
    rows: ["AI", "Reply language", "AI tools"],
    agent_counts: agent_counts_en,
    plan_notice: "Butler's AI requests use your ChatGPT plan.",
    manage_usage: "Manage usage",
    providers: [
        "ChatGPT",
        "Claude",
        "Gemini",
        "OpenAI API",
        "Grok",
        "Qwen",
        "Kimi",
        "Z.AI Coding Plan",
        "Z.AI API",
        "OpenCode Go",
        "Other (OpenAI-compatible)",
    ],
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
