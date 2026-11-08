//! The copy of the MCP page. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// settings.pageSections.mcpServers
    pub(super) servers: &'static str,
    /// settings.actions.addMcpServer
    pub(super) add: &'static str,
    /// settings.mcpToolFilterReview
    pub(super) tool_filter_review: &'static str,
    /// settings.mcpEnabled
    pub(super) enabled_meta: &'static str,
    /// settings.mcpDisabled
    pub(super) disabled_meta: &'static str,
    /// settings.mcpNeedsSecret
    pub(super) needs_secret: &'static str,
    /// settings.deleteMcpServer
    pub(super) delete_confirm: fn(&str) -> String,
    /// settings.mcpIdRequired
    pub(super) id_required: &'static str,
    /// settings.mcpIdInvalid
    pub(super) id_invalid: &'static str,
    /// settings.mcpIdPreview
    pub(super) id_preview: fn(&str) -> String,
    /// settings.fields.mcpServerId
    pub(super) server_id: &'static str,
    /// settings.fields.mcpServerName
    pub(super) server_name: &'static str,
    /// settings.fields.mcpTransport
    pub(super) transport: &'static str,
    /// settings.fields.enabled
    pub(super) enabled: &'static str,
    /// settings.fields.mcpCommand
    pub(super) command: &'static str,
    /// settings.fields.mcpArgs
    pub(super) args: &'static str,
    /// settings.fields.mcpCwd
    pub(super) cwd: &'static str,
    /// settings.fields.mcpEnv
    pub(super) env: &'static str,
    /// settings.fields.mcpUrl
    pub(super) url: &'static str,
    /// settings.fields.mcpHeaders
    pub(super) headers: &'static str,
    /// settings.options.stdio
    pub(super) stdio: &'static str,
    /// settings.options.http
    pub(super) http: &'static str,
    /// settings.options.sse
    pub(super) sse: &'static str,
    /// settings.placeholders.mcpArgs
    pub(super) args_placeholder: &'static str,
    /// settings.descriptions.mcpSecrets
    pub(super) secrets: &'static str,
    /// interfaceDetails.noMcp
    pub(super) no_servers: &'static str,
    /// interfaceDetails.addEnvironment
    pub(super) add_environment: &'static str,
    /// interfaceDetails.addHeader
    pub(super) add_header: &'static str,
    /// interfaceDetails.literal
    pub(super) literal: &'static str,
    /// interfaceDetails.envReference
    pub(super) env_reference: &'static str,
    /// interfaceStatus.file
    pub(super) file: &'static str,
    /// interfaceDetails.noEntries
    pub(super) no_entries: &'static str,
    /// interfaceDetails.applyAllSources
    pub(super) apply_all: &'static str,
    /// interfaceDetails.secretPlaceholder
    pub(super) secret_placeholder: &'static str,
    /// interfaceTemplates.deleteRow
    pub(super) delete_row: fn(&str) -> String,
    /// settings.saved
    pub(super) saved: &'static str,
    /// common.save
    pub(super) save: &'static str,
    /// common.cancel
    pub(super) cancel: &'static str,
    /// common.delete
    pub(super) delete_word: &'static str,
    /// settings.mcpErrors.save
    pub(super) err_save: &'static str,
    /// settings.mcpErrors.unavailable
    pub(super) err_unavailable: &'static str,
    /// settings.mcpErrors.remove
    pub(super) err_remove: &'static str,
    /// settings.mcpErrors.toggle
    pub(super) err_toggle: &'static str,
    /// settings.mcpErrors.probe
    pub(super) err_probe: &'static str,
    /// settings.mcpActionFailed
    pub(super) action_failed: &'static str,
    /// interfaceFeedback.requestFailed
    pub(super) request_failed: &'static str,
    /// canon.mcp.connectedTools
    pub(super) connected_tools: &'static str,
    /// canon.mcp.noTools
    pub(super) no_tools: &'static str,
    /// canon.mcp.capabilityCount
    pub(super) capability_count: fn(usize) -> String,
    /// canon.mcp.states: allowed, pending, denied, revoked
    pub(super) states: [&'static str; 4],
    /// canon.mcp.revoke
    pub(super) revoke: &'static str,
    /// canon.mcp.remove
    pub(super) remove: &'static str,
    /// canon.mcp.revoked
    pub(super) revoked: &'static str,
    /// canon.mcp.deleted
    pub(super) deleted: &'static str,
}

const KO: Words = Words {
    servers: "서버",
    add: "MCP 서버 추가",
    tool_filter_review: "도구 제한 확인 필요",
    enabled_meta: "사용 중",
    disabled_meta: "사용 안 함",
    needs_secret: "키 입력 필요",
    delete_confirm: |name| format!("MCP 서버 \"{name}\"과 저장된 인증 정보를 삭제합니다."),
    id_required: "서버 ID를 입력합니다.",
    id_invalid: "영문·숫자·점·밑줄·하이픈 1~80자로 입력합니다.",
    id_preview: |id| format!("저장 ID: {id}"),
    server_id: "서버 ID",
    server_name: "표시 이름",
    transport: "연결 방식",
    enabled: "사용",
    command: "명령",
    args: "인자",
    cwd: "작업 폴더",
    env: "환경 변수",
    url: "URL",
    headers: "헤더",
    stdio: "stdio",
    http: "Streamable HTTP",
    sse: "SSE",
    args_placeholder: "한 줄에 하나씩 입력",
    secrets: "값의 출처, 키, 값을 행 단위로 입력합니다. 필요하면 같은 출처를 전체 행에 적용할 수 있고, 저장된 값은 화면과 API 응답에서 숨깁니다.",
    no_servers: "등록된 MCP 서버가 없습니다.",
    add_environment: "환경 변수 추가",
    add_header: "헤더 추가",
    literal: "직접값",
    env_reference: "환경 변수 참조",
    file: "파일",
    no_entries: "추가된 항목이 없습니다.",
    apply_all: "전체 출처 적용",
    secret_placeholder: "저장된 값 유지 또는 새 값",
    delete_row: |title| format!("{title} 행 삭제"),
    saved: "저장됨",
    save: "저장",
    cancel: "취소",
    delete_word: "삭제",
    err_save: "서버를 저장하지 못했습니다.",
    err_unavailable: "MCP 설정을 열지 못했습니다.",
    err_remove: "서버를 삭제하지 못했습니다.",
    err_toggle: "변경하지 못했습니다.",
    err_probe: "연결을 확인하지 못했습니다.",
    action_failed: "서버 작업에 실패했습니다.",
    request_failed: "요청을 처리하지 못했습니다.",
    connected_tools: "버틀러에 연결된 도구",
    no_tools: "연결된 도구가 없습니다",
    capability_count: |count| format!("권한 {count}개"),
    states: ["허용됨", "대기 중", "거절됨", "해제됨"],
    revoke: "권한 해제",
    remove: "지우기",
    revoked: "권한을 해제했습니다",
    deleted: "지웠습니다",
};

const EN: Words = Words {
    servers: "Servers",
    add: "Add MCP server",
    tool_filter_review: "Review tool limits",
    enabled_meta: "Enabled",
    disabled_meta: "Disabled",
    needs_secret: "Needs a key",
    delete_confirm: |name| format!("Delete MCP server \"{name}\" and its saved credentials."),
    id_required: "Enter a server ID.",
    id_invalid: "Use letters, numbers, dots, underscores or hyphens (1–80).",
    id_preview: |id| format!("Saved ID: {id}"),
    server_id: "Server ID",
    server_name: "Display name",
    transport: "Transport",
    enabled: "Enabled",
    command: "Command",
    args: "Arguments",
    cwd: "Working folder",
    env: "Environment variables",
    url: "URL",
    headers: "Headers",
    stdio: "stdio",
    http: "Streamable HTTP",
    sse: "SSE",
    args_placeholder: "One argument per line",
    secrets: "Enter source, key, and value by row. Stored values are hidden from the screen and API responses.",
    no_servers: "No MCP servers registered.",
    add_environment: "Add environment variable",
    add_header: "Add header",
    literal: "Literal value",
    env_reference: "Environment reference",
    file: "File",
    no_entries: "No entries added.",
    apply_all: "Apply source to all",
    secret_placeholder: "Keep saved value or enter a new value",
    delete_row: |title| format!("Delete {title} row"),
    saved: "Saved",
    save: "Save",
    cancel: "Cancel",
    delete_word: "Delete",
    err_save: "Couldn't save the server.",
    err_unavailable: "Couldn't open MCP settings.",
    err_remove: "Couldn't remove the server.",
    err_toggle: "Couldn't change it.",
    err_probe: "Couldn't reach the server.",
    action_failed: "Server action failed.",
    request_failed: "Request failed.",
    connected_tools: "Connected tools",
    no_tools: "No connected tools",
    capability_count: |count| format!("{count} capabilities"),
    states: ["Allowed", "Pending", "Denied", "Revoked"],
    revoke: "Revoke",
    remove: "Delete",
    revoked: "Access revoked",
    deleted: "Deleted",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
