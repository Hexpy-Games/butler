//! The Hooks copy. Each field names its `packages/butler-i18n` key (`settings.hooks.*` unless
//! noted).
use butler_ds::ui::context::Lang;

pub(super) struct HooksCopy {
    /// settings.pageSections.hooks
    pub(super) title: &'static str,
    /// common.delete
    pub(super) delete: &'static str,
    /// common.save
    pub(super) save: &'static str,
    /// interfaceFeedback.requestFailed
    pub(super) request_failed: &'static str,
    pub(super) add: &'static str,
    pub(super) edit: &'static str,
    pub(super) test: &'static str,
    pub(super) remove: &'static str,
    pub(super) recent: &'static str,
    pub(super) empty: &'static str,
    pub(super) name: &'static str,
    pub(super) event: &'static str,
    pub(super) tools: &'static str,
    pub(super) command: &'static str,
    pub(super) args: &'static str,
    pub(super) timeout: &'static str,
    pub(super) fail_closed: &'static str,
    /// `async`
    pub(super) background: &'static str,
    pub(super) enabled: &'static str,
    pub(super) refresh: &'static str,
    pub(super) blocked: &'static str,
    pub(super) edit_title: &'static str,
    pub(super) disabled: &'static str,
    pub(super) empty_runs: &'static str,
    pub(super) test_success: &'static str,
    pub(super) test_failure: &'static str,
    pub(super) exit_code: &'static str,
    pub(super) command_disabled: &'static str,
    pub(super) command_required: &'static str,
    pub(super) delete_confirm: fn(&str) -> String,
}

static KO: HooksCopy = HooksCopy {
    title: "내 훅",
    delete: "삭제",
    save: "저장",
    request_failed: "요청을 처리하지 못했습니다.",
    add: "훅 추가",
    edit: "편집",
    test: "테스트",
    remove: "삭제",
    recent: "최근 실행",
    empty: "훅 없음",
    name: "이름",
    event: "이벤트",
    tools: "도구",
    command: "명령",
    args: "인수 (JSON)",
    timeout: "제한 시간 (ms)",
    fail_closed: "오류 시 차단",
    background: "백그라운드",
    enabled: "사용",
    refresh: "새로고침",
    blocked: "훅이 차단함",
    edit_title: "훅 편집",
    disabled: "사용 안 함",
    empty_runs: "실행 기록 없음",
    test_success: "실행 성공",
    test_failure: "실행 실패",
    exit_code: "종료 코드",
    command_disabled: "인수를 사용 중입니다.",
    command_required: "명령 또는 인수를 입력합니다.",
    delete_confirm: |name| format!("훅 \"{name}\"을 삭제합니다."),
};

static EN: HooksCopy = HooksCopy {
    title: "Your hooks",
    delete: "Delete",
    save: "Save",
    request_failed: "Request failed.",
    add: "Add hook",
    edit: "Edit",
    test: "Test",
    remove: "Delete",
    recent: "Recent runs",
    empty: "No hooks",
    name: "Name",
    event: "Event",
    tools: "Tools",
    command: "Command",
    args: "Args (JSON)",
    timeout: "Timeout (ms)",
    fail_closed: "Block on error",
    background: "Background",
    enabled: "Enabled",
    refresh: "Refresh",
    blocked: "Blocked by hook",
    edit_title: "Edit hook",
    disabled: "Disabled",
    empty_runs: "No runs yet",
    test_success: "Run succeeded",
    test_failure: "Run failed",
    exit_code: "Exit code",
    command_disabled: "Using arguments.",
    command_required: "Enter a command or arguments.",
    delete_confirm: |name| format!("Delete hook \"{name}\"."),
};

pub(super) fn words(lang: Lang) -> &'static HooksCopy {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
