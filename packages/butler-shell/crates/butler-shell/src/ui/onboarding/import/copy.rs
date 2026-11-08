//! The import step's copy (KO/EN). Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// firstRun.next
    pub(super) next: &'static str,
    /// firstRun.import.agentsTitle
    pub(super) agents_title: &'static str,
    /// firstRun.import.agentsBody
    pub(super) agents_body: &'static str,
    /// firstRun.import.agentsEmpty
    pub(super) agents_empty: &'static str,
    /// firstRun.import.importAction
    pub(super) import_action: &'static str,
    /// firstRun.import.importing
    pub(super) importing: &'static str,
    /// firstRun.import.searching
    pub(super) searching: &'static str,
    /// firstRun.import.skip
    pub(super) skip: &'static str,
    /// firstRun.import.pickOne
    pub(super) pick_one: &'static str,
    /// firstRun.import.agentsDoneTitle
    pub(super) done_title: &'static str,
    /// firstRun.import.agentsNothing
    pub(super) nothing: &'static str,
    /// firstRun.import.itemInstructions
    pub(super) item_instructions: &'static str,
    /// firstRun.import.itemServer
    pub(super) item_server: &'static str,
    /// firstRun.import.itemNeedsKey
    pub(super) item_needs_key: &'static str,
    /// firstRun.import.itemFileEmpty
    pub(super) file_empty: &'static str,
    /// firstRun.import.itemFileUnreadable
    pub(super) file_unreadable: &'static str,
    /// firstRun.import.itemFileTooLarge
    pub(super) file_too_large: &'static str,
    /// settings.agentImport.failed
    pub(super) failed: &'static str,
    /// settings.agentImport.found, nothing to import
    found_none: &'static str,
}

const KO: Words = Words {
    next: "다음",
    agents_title: "다른 AI에서 가져오기",
    agents_body: "지침과 MCP 서버를 옮깁니다.",
    agents_empty: "가져올 AI 도구 없음",
    import_action: "가져오기",
    importing: "가져오는 중…",
    searching: "찾는 중…",
    skip: "건너뛰기",
    pick_one: "하나 이상 고르세요",
    done_title: "다른 AI에서 가져왔습니다",
    nothing: "새로 추가할 항목 없음",
    item_instructions: "지침",
    item_server: "MCP 서버",
    item_needs_key: "키 입력 필요",
    file_empty: "비어 있는 파일",
    file_unreadable: "읽을 수 없는 파일",
    file_too_large: "너무 큰 파일",
    failed: "가져오지 못했어요",
    found_none: "가져올 설정 없음",
};

const EN: Words = Words {
    next: "Next",
    agents_title: "Import from other AI tools",
    agents_body: "Brings over instructions and MCP servers.",
    agents_empty: "No AI tools to import",
    import_action: "Import",
    importing: "Importing…",
    searching: "Looking…",
    skip: "Skip",
    pick_one: "Pick at least one",
    done_title: "Imported from other AI tools",
    nothing: "Nothing new to add",
    item_instructions: "Instructions",
    item_server: "MCP server",
    item_needs_key: "Needs a key",
    file_empty: "Empty file",
    file_unreadable: "Can't read this file",
    file_too_large: "File too large",
    failed: "Couldn't import",
    found_none: "Nothing to import",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

fn plural(count: u64) -> &'static str {
    if count == 1 { "" } else { "s" }
}

/// firstRun.import.agentsAdded
pub(super) fn added(lang: Lang, instructions: u64, servers: u64) -> String {
    match lang {
        Lang::Ko => format!("지침 {instructions}개 · MCP 서버 {servers}개 추가"),
        Lang::En => format!(
            "{instructions} instruction{} · {servers} MCP server{} added",
            plural(instructions),
            plural(servers)
        ),
    }
}

/// firstRun.import.agentsNeedsKey
pub(super) fn needs_key(lang: Lang, count: u64) -> String {
    match lang {
        Lang::Ko => format!("키 입력 필요 {count}개 — 설정 › MCP"),
        Lang::En => format!(
            "{count} need{} a key — Settings › MCP",
            if count == 1 { "s" } else { "" }
        ),
    }
}

/// firstRun.import.agentItemsTitle
pub(super) fn items_title(lang: Lang, name: &str) -> String {
    match lang {
        Lang::Ko => format!("{name}에서 가져올 내용"),
        Lang::En => format!("What to import from {name}"),
    }
}

/// firstRun.import.agentItemsProgress
pub(super) fn items_progress(name: &str, index: usize, total: usize) -> String {
    format!("{name} · {index}/{total}")
}

/// settings.agentImport.found
pub(super) fn found(lang: Lang, instructions: bool, servers: u64) -> String {
    let mut parts = Vec::new();
    if instructions {
        parts.push(match lang {
            Lang::Ko => "지침".to_owned(),
            Lang::En => "Instructions".to_owned(),
        });
    }
    if servers > 0 {
        parts.push(match lang {
            Lang::Ko => format!("MCP 서버 {servers}개"),
            Lang::En => format!("{servers} MCP server{}", plural(servers)),
        });
    }
    if parts.is_empty() {
        words(lang).found_none.to_owned()
    } else {
        parts.join(" · ")
    }
}
