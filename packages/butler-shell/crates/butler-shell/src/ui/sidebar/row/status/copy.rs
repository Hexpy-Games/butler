//! Status copy from butler-i18n/src/locales/{en,ko}.ts, indexed once on use.
mod additional;
use std::{collections::HashMap, sync::LazyLock};
type Row = (&'static str, &'static str, &'static str);
type Labels = HashMap<&'static str, (&'static str, &'static str)>;
#[derive(Clone, Copy)]
pub(super) enum Catalog {
    Tools,
    Operations,
    Worker,
    Guided,
    Progress,
}
fn index(rows: impl Iterator<Item = Row>) -> Labels {
    rows.map(|(key, en, ko)| (key, (en, ko))).collect()
}
static TOOLS: LazyLock<Labels> =
    LazyLock::new(|| index(additional::ROWS.iter().chain(TOOL_BASE).copied()));
static OPERATIONS: LazyLock<Labels> = LazyLock::new(|| index(OPERATION_ROWS.iter().copied()));
static WORKER: LazyLock<Labels> = LazyLock::new(|| index(WORKER_ROWS.iter().copied()));
static GUIDED: LazyLock<Labels> = LazyLock::new(|| index(GUIDED_ROWS.iter().copied()));
static PROGRESS: LazyLock<Labels> = LazyLock::new(|| index(PROGRESS_ROWS.iter().copied()));
pub(super) fn lookup(catalog: Catalog, key: &str) -> Option<(&'static str, &'static str)> {
    let labels = match catalog {
        Catalog::Tools => &*TOOLS,
        Catalog::Operations => &*OPERATIONS,
        Catalog::Worker => &*WORKER,
        Catalog::Guided => &*GUIDED,
        Catalog::Progress => &*PROGRESS,
    };
    labels.get(key).copied()
}
const TOOL_BASE: &[Row] = &[
    ("browser_open", "Open tab", "탭 열기"),
    ("browser_observe", "Read page", "페이지 읽기"),
    ("browser_act", "Browser action", "브라우저 조작"),
    ("browser_tabs", "Check tabs", "탭 확인"),
    ("browser_close", "Close tab", "탭 닫기"),
    ("browser_sign_in", "Sign in", "로그인"),
    (
        "browser_site_access",
        "Use signed-in site",
        "로그인 사이트 사용",
    ),
    (
        "browser_sign_in_wait",
        "Sign-in needs you",
        "로그인 확인 필요",
    ),
    ("browser_pay_fill", "Fill payment card", "결제 정보 입력"),
    ("browser_autofill_fill", "Fill my info", "내 정보 입력"),
    ("browser_pay_wait", "Payment needs you", "결제 확인 필요"),
    ("browser_wait_for_user", "Wait for you", "직접 조작 대기"),
    (
        "read_project_source",
        "Read project source",
        "프로젝트 원문 읽기",
    ),
    ("web_search", "Web search", "웹 검색"),
    ("web_read", "Read web page", "웹 문서 읽기"),
    ("read_file", "Read file", "파일 읽기"),
    ("list_files", "Find workspace files", "작업공간 파일 찾기"),
    ("grep_files", "Search workspace", "작업공간 검색"),
    ("write_file", "Write file", "작성"),
    ("edit_file", "Edit file", "수정"),
    (
        "tool_search",
        "Find available tools",
        "사용 가능한 도구 찾기",
    ),
    (
        "tool_describe",
        "Check tool instructions",
        "도구 사용법 확인",
    ),
    ("tool_call", "Run tool", "도구 실행"),
    ("run_command", "Run command", "명령 실행"),
    (
        "project_ledger_change",
        "Update project records",
        "프로젝트 기록 변경",
    ),
    (
        "project_ledger_read",
        "Read project records",
        "프로젝트 기록 확인",
    ),
    ("start_work", "Check request", "요청 내용 확인"),
    ("continue_work", "Check progress", "진행 내용 확인"),
    ("replace_work_plan", "Plan execution", "실행 계획 수립"),
    (
        "record_work_checkpoint",
        "Check work progress",
        "작업 진행 확인",
    ),
    ("record_work_review", "Review results", "결과 검토"),
    ("plan_review", "Review plan", "계획 검토"),
    ("completion_review", "Review completion", "완료 검토"),
    (
        "record_work_disposition",
        "Record completion",
        "완료 상태 기록",
    ),
    ("work_tool", "Update work status", "작업 상태 변경"),
    ("tool_work", "Tool work", "도구 작업"),
    ("fallback", "Working", "작업 중"),
];
const OPERATION_ROWS: &[Row] = &[
    ("ask_user", "Question", "질문"),
    (
        "read_project_source",
        "Read: checking the attached project source",
        "조회: 첨부한 프로젝트 원문을 확인 중",
    ),
    ("delegate_to_worker", "Call worker", "작업자 호출"),
    (
        "edit_file",
        "Editing: applying planned file changes",
        "수정: 계획한 파일 변경을 적용 중",
    ),
    (
        "grep_files",
        "Searching: locating relevant implementation",
        "검색: 관련 구현을 찾는 중",
    ),
    (
        "list_files",
        "Reading: checking relevant files",
        "조회: 관련 파일 목록을 확인 중",
    ),
    (
        "project_ledger_read",
        "Reading: checking project records",
        "조회: 프로젝트 기록을 확인 중",
    ),
    (
        "promote_reviewed_candidate",
        "Applying: promoting reviewed changes",
        "적용: 검토된 변경을 반영 중",
    ),
    (
        "read_file",
        "Reading: checking relevant file contents",
        "조회: 관련 파일 내용을 확인 중",
    ),
    (
        "read_operation_result",
        "Checking: reviewing stored operation results",
        "확인: 저장된 작업 결과를 검토 중",
    ),
    ("run_command", "Running command", "명령 실행"),
    (
        "update_onboarding_profile",
        "Settings: applying onboarding answers",
        "설정: 처음 알려주신 내용을 반영 중",
    ),
    (
        "web_read",
        "Reading: checking public sources",
        "조회: 공개 자료를 확인 중",
    ),
    (
        "web_search",
        "Searching: finding public sources",
        "검색: 공개 자료를 찾는 중",
    ),
    (
        "write_file",
        "Writing: applying planned file changes",
        "작성: 계획한 파일 변경을 적용 중",
    ),
];
const WORKER_ROWS: &[Row] = &[
    ("waiting", "Waiting", "대기"),
    ("orienting", "Thinking", "구상 중"),
    ("planning", "Planning", "계획 중"),
    ("verifying", "Reviewing", "검토 중"),
    ("reporting", "Reporting", "보고 중"),
    ("complete", "Complete", "완료"),
    ("blocked", "Blocked", "진행이 막힘"),
    ("failed", "Failed", "실패"),
    ("cancelled", "Cancelled", "취소됨"),
    ("recoverable", "Ready to resume", "이어서 진행 가능"),
    ("executing", "Working", "작업 중"),
    ("approval", "Awaiting approval", "허용 대기 중"),
    (
        "waiting_for_form",
        "Waiting for your approval.",
        "허용 여부를 기다리고 있습니다.",
    ),
    ("delivered", "Work completed.", "작업을 완료했습니다."),
    (
        "interrupted",
        "Work was interrupted. You can resume it.",
        "작업이 중단되었습니다. 이어서 진행할 수 있습니다.",
    ),
    (
        "waitingForChildren",
        "Waiting for worker results.",
        "작업자 결과를 기다리는 중입니다.",
    ),
];
const GUIDED_ROWS: &[Row] = &[
    (
        "checkingPrevious",
        "Checking previous work and its current state.",
        "이전에 진행하던 내용과 현재 상태를 확인하고 있습니다.",
    ),
    (
        "checkingRequest",
        "Clarifying the request and required outcome.",
        "요청하신 내용과 필요한 결과를 정리하고 있습니다.",
    ),
    (
        "toolWorking",
        "Working with tools.",
        "도구 작업을 진행하고 있습니다",
    ),
    (
        "checkingInformation",
        "Checking information needed for the work.",
        "작업에 필요한 정보를 확인하고 있습니다.",
    ),
    (
        "commandExecuting",
        "Running the required workspace commands.",
        "작업 공간에서 필요한 명령을 실행하고 있습니다.",
    ),
    (
        "conceptionTitle",
        "Confirm request intent",
        "요청 의도 확인",
    ),
    (
        "planningNext",
        "Define the work order and validation criteria for the request.",
        "요청에 맞는 작업 순서와 검증 기준을 정합니다.",
    ),
    ("reportTitle", "Report results", "결과 보고"),
];
const PROGRESS_ROWS: &[Row] = &[
    (
        "fallback",
        "Working: using the planned tool",
        "작업: 계획한 도구를 사용 중",
    ),
    (
        "storageRecovery",
        "Coordinating storage writes",
        "저장소 쓰기 순서를 조정하고 있습니다",
    ),
    ("reconnecting", "Reconnecting", "재연결 중"),
    (
        "stopping",
        "Stopping the request",
        "요청을 중지하고 있습니다",
    ),
    ("working", "Working", "작업 중"),
    ("generating", "Generating response", "응답 생성 중"),
    ("accepted", "Request accepted.", "요청을 접수했습니다."),
    ("attention", "Needs attention", "확인 필요"),
    ("spaceWorking", "Working", "작업 중"),
];
