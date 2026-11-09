//! The copy of the log trace page, its title and the log storage section. Each field names its
//! `packages/butler-i18n` key (`settings.logs.*`, `settings.logs.trace.*`).
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;

/// A key and its label: `trace.steps` and `trace.attrs`.
type Table = &'static [(&'static str, &'static str)];

pub(super) struct Words {
    /// common.breadcrumb
    pub(super) breadcrumb: &'static str,
    /// settings.logs.trace.title
    pub(super) title: &'static str,
    /// settings.logs.trace.sections.summary
    pub(super) summary: &'static str,
    /// settings.logs.trace.sections.steps
    pub(super) steps_title: &'static str,
    /// settings.logs.trace.fields: result, duration, model, started, chat, traceId
    pub(super) fields: [&'static str; 6],
    /// settings.logs.trace.outcome.ok
    pub(super) outcome_ok: &'static str,
    /// settings.logs.trace.outcome.error
    pub(super) outcome_error: &'static str,
    /// settings.logs.trace.retries: `{count}` is the number
    pub(super) retries_one: &'static str,
    pub(super) retries_many: &'static str,
    /// settings.logs.trace.failed
    pub(super) failed: &'static str,
    /// settings.logs.trace.wait
    pub(super) wait: &'static str,
    /// settings.logs.trace.running
    pub(super) running: &'static str,
    /// settings.logs.trace.partial
    pub(super) partial: &'static str,
    /// settings.logs.trace.notFound
    pub(super) not_found: &'static str,
    /// settings.logs.trace.loadFailed
    pub(super) load_failed: &'static str,
    /// settings.logs.trace.copyId
    pub(super) copy_id: &'static str,
    /// settings.logs.trace.seconds: `{value}` is the number
    pub(super) seconds: &'static str,
    /// settings.logs.trace.spoken: `{start}` and `{length}`
    pub(super) spoken: &'static str,
    /// settings.logs.trace.depth: `{level}` is the number
    pub(super) depth: &'static str,
    /// settings.logs.trace.steps
    pub(super) steps: Table,
    /// settings.logs.trace.attrs
    pub(super) attrs: Table,
    /// settings.logs.fields: method, url, status, headers
    pub(super) http_fields: [&'static str; 4],
    /// settings.logs.copied
    pub(super) copied: &'static str,
    /// settings.logs.sections.storage
    pub(super) storage: &'static str,
    /// settings.logs.stores: app, main, debug, bodies
    pub(super) stores: [&'static str; 4],
    /// settings.logs.storeMeta: `{used}`, `{limit}`, `{retention}`
    pub(super) store_meta: &'static str,
    /// settings.logs.retentionHours: `{hours}`
    pub(super) retention_hours: &'static str,
    /// settings.logs.retentionDays: `{days}`
    pub(super) retention_days: &'static str,
    /// settings.logs.exportMenu
    pub(super) export_menu: &'static str,
    /// settings.logs.exportTitle
    pub(super) export_title: &'static str,
    /// settings.logs.exportRange
    pub(super) export_range: &'static str,
    /// settings.logs.includeBodies
    pub(super) include_bodies: &'static str,
    /// settings.logs.exportAction
    pub(super) export_action: &'static str,
    /// settings.logs.exported
    pub(super) exported: &'static str,
    /// settings.logs.exportFailed
    pub(super) export_failed: &'static str,
    /// settings.logs.clearMenu
    pub(super) clear_menu: &'static str,
    /// settings.logs.clearTitle
    pub(super) clear_title: &'static str,
    /// settings.logs.clearBody
    pub(super) clear_body: &'static str,
    /// settings.logs.exportDescription
    pub(super) export_description: &'static str,
    /// settings.logs.clearLabel
    pub(super) clear_label: &'static str,
    /// settings.logs.clearDescription
    pub(super) clear_description: &'static str,
    /// settings.logs.cleared: `{size}`
    pub(super) cleared: &'static str,
    /// settings.logs.clearFailed
    pub(super) clear_failed: &'static str,
    /// settings.logs.periods: hour, day, week, all
    pub(super) periods: [&'static str; 4],
    /// common.delete
    pub(super) delete: &'static str,
    /// common.cancel
    pub(super) cancel: &'static str,
}

const KO: Words = Words {
    breadcrumb: "현재 위치",
    title: "메시지 추적",
    summary: "요약",
    steps_title: "단계",
    fields: ["결과", "전체 시간", "모델", "시작", "대화", "추적 ID"],
    outcome_ok: "완료",
    outcome_error: "실패",
    retries_one: "재시도 {count}회",
    retries_many: "재시도 {count}회",
    failed: "실패",
    wait: "대기",
    running: "진행 중",
    partial: "일부만 표시",
    not_found: "추적 기록이 없습니다",
    load_failed: "추적을 불러오지 못했습니다",
    copy_id: "추적 ID 복사",
    seconds: "{value}초",
    spoken: "시작 {start}, {length}",
    depth: "깊이 {level}",
    steps: &[
        ("http.server", "앱 요청"),
        ("turn.admit", "메시지 접수"),
        ("turn.queue", "대기열"),
        ("turn.dispatch", "턴 시작"),
        ("turn.run", "턴 실행"),
        ("turn.deliver", "전달"),
        ("route.select", "모델 선택"),
        ("context.build", "컨텍스트 구성"),
        ("model.request", "모델 요청"),
        ("retry.wait", "재시도 대기"),
        ("http.request", "HTTP 요청"),
        ("stream.receive", "스트림 수신"),
        ("tool.call", "도구 호출"),
        ("mcp.call", "MCP 호출"),
        ("memory.write", "기억 저장"),
        ("memory.recall", "기억 불러오기"),
        ("schedule.run", "예약 작업 실행"),
    ],
    attrs: &[
        ("model", "모델"),
        ("attempt", "시도"),
        ("attempts", "최대 시도"),
        ("chosen", "선택"),
        ("key_source", "키 출처"),
        ("sections", "섹션"),
        ("tokens", "토큰"),
        ("delay_ms", "대기 시간"),
        ("provider", "제공자"),
        ("name", "이름"),
        ("method", "메서드"),
        ("count", "개수"),
        ("final_action", "최종 전달"),
        ("message_id", "메시지 ID"),
        ("run_id", "실행 ID"),
        ("purpose", "용도"),
        ("phase", "단계"),
        ("retry", "재시도"),
        ("host", "호스트"),
        ("port", "포트"),
        ("path", "경로"),
        ("status", "상태"),
        ("first_byte_ms", "첫 바이트"),
        ("total_ms", "전체 시간"),
        ("request_bytes", "요청 크기"),
        ("response_bytes", "응답 크기"),
        ("chunks", "청크"),
        ("response_complete", "응답 완료"),
        ("failure", "오류"),
        ("turn_id", "턴 ID"),
        ("chat_id", "대화 ID"),
        ("reason", "이유"),
    ],
    http_fields: ["메서드", "URL", "상태", "헤더"],
    copied: "복사함",
    storage: "저장 공간",
    stores: ["앱", "에이전트", "자세히", "본문"],
    store_meta: "{used} / {limit} · {retention} 보관",
    retention_hours: "{hours}시간",
    retention_days: "{days}일",
    export_menu: "내보내기…",
    export_title: "로그 내보내기",
    export_range: "기간",
    include_bodies: "본문 포함",
    export_action: "내보내기",
    exported: "내보냈습니다.",
    export_failed: "내보내지 못했습니다.",
    clear_menu: "모두 삭제…",
    clear_title: "로그를 모두 삭제할까요?",
    clear_body: "저장된 로그와 본문을 지웁니다.",
    export_description: "저장된 로그를 파일로 저장합니다.",
    clear_label: "로그 모두 삭제",
    clear_description: "저장된 로그와 본문을 지웁니다. 되돌릴 수 없습니다.",
    cleared: "{size}를 비웠습니다.",
    clear_failed: "삭제하지 못했습니다.",
    periods: ["1시간", "24시간", "7일", "전체 기간"],
    delete: "삭제",
    cancel: "취소",
};

const EN: Words = Words {
    breadcrumb: "Location",
    title: "Message trace",
    summary: "Summary",
    steps_title: "Steps",
    fields: [
        "Result",
        "Total time",
        "Model",
        "Started",
        "Chat",
        "Trace ID",
    ],
    outcome_ok: "Done",
    outcome_error: "Failed",
    retries_one: "1 retry",
    retries_many: "{count} retries",
    failed: "Failed",
    wait: "Wait",
    running: "Running",
    partial: "Partial",
    not_found: "No trace found",
    load_failed: "Couldn't load the trace",
    copy_id: "Copy trace ID",
    seconds: "{value}s",
    spoken: "Starts {start}, {length}",
    depth: "Depth {level}",
    steps: &[
        ("http.server", "App request"),
        ("turn.admit", "Admit message"),
        ("turn.queue", "Queue"),
        ("turn.dispatch", "Start turn"),
        ("turn.run", "Run turn"),
        ("turn.deliver", "Deliver"),
        ("route.select", "Pick model"),
        ("context.build", "Build context"),
        ("model.request", "Model request"),
        ("retry.wait", "Retry wait"),
        ("http.request", "HTTP request"),
        ("stream.receive", "Receive stream"),
        ("tool.call", "Tool call"),
        ("mcp.call", "MCP call"),
        ("memory.write", "Save memory"),
        ("memory.recall", "Recall memory"),
        ("schedule.run", "Run schedule"),
    ],
    attrs: &[
        ("model", "Model"),
        ("attempt", "Attempt"),
        ("attempts", "Max attempts"),
        ("chosen", "Chosen"),
        ("key_source", "Key source"),
        ("sections", "Sections"),
        ("tokens", "Tokens"),
        ("delay_ms", "Delay"),
        ("provider", "Provider"),
        ("name", "Name"),
        ("method", "Method"),
        ("count", "Count"),
        ("final_action", "Final delivery"),
        ("message_id", "Message ID"),
        ("run_id", "Run ID"),
        ("purpose", "Purpose"),
        ("phase", "Phase"),
        ("retry", "Retry"),
        ("host", "Host"),
        ("port", "Port"),
        ("path", "Path"),
        ("status", "Status"),
        ("first_byte_ms", "First byte"),
        ("total_ms", "Total time"),
        ("request_bytes", "Request size"),
        ("response_bytes", "Response size"),
        ("chunks", "Chunks"),
        ("response_complete", "Response complete"),
        ("failure", "Error"),
        ("turn_id", "Turn ID"),
        ("chat_id", "Chat ID"),
        ("reason", "Reason"),
    ],
    http_fields: ["Method", "URL", "Status", "Headers"],
    copied: "Copied",
    storage: "Storage",
    stores: ["App", "Agent", "Detailed", "Bodies"],
    store_meta: "{used} of {limit} · kept {retention}",
    retention_hours: "{hours} hours",
    retention_days: "{days} days",
    export_menu: "Export…",
    export_title: "Export logs",
    export_range: "Period",
    include_bodies: "Include bodies",
    export_action: "Export",
    exported: "Exported.",
    export_failed: "Couldn't export.",
    clear_menu: "Delete all…",
    clear_title: "Delete all logs?",
    clear_body: "Saved logs and bodies are removed.",
    export_description: "Saves the stored logs to a file.",
    clear_label: "Delete all logs",
    clear_description: "Removes saved logs and bodies. This can't be undone.",
    cleared: "Freed {size}.",
    clear_failed: "Couldn't delete.",
    periods: ["1 hour", "24 hours", "7 days", "All time"],
    delete: "Delete",
    cancel: "Cancel",
};

/// The copy of `lang`.
pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

/// The copy of the app language.
pub(super) fn get(cx: &App) -> &'static Words {
    words(Ds::get(cx).lang())
}

impl Words {
    /// `copy.steps[name]`
    pub(super) fn step(&self, name: &str) -> Option<&'static str> {
        lookup(self.steps, name)
    }

    /// `labels[key]`
    pub(super) fn attr(&self, key: &str) -> Option<&'static str> {
        lookup(self.attrs, key)
    }

    /// `copy.retries(count)`
    pub(super) fn retries(&self, count: usize) -> String {
        let template = if count == 1 {
            self.retries_one
        } else {
            self.retries_many
        };
        template.replace("{count}", &count.to_string())
    }

    /// `copy.seconds(value)`
    pub(super) fn seconds(&self, value: &str) -> String {
        self.seconds.replace("{value}", value)
    }

    /// `copy.spoken(start, length)`
    pub(super) fn spoken(&self, start: &str, length: &str) -> String {
        self.spoken
            .replace("{start}", start)
            .replace("{length}", length)
    }

    /// `copy.depth(level)`
    pub(super) fn depth(&self, level: u32) -> String {
        self.depth.replace("{level}", &level.to_string())
    }
}

fn lookup(table: Table, key: &str) -> Option<&'static str> {
    table
        .iter()
        .find_map(|(name, label)| (*name == key).then_some(*label))
}
