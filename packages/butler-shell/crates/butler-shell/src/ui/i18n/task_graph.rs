//! The task graph panel's copy. Each field names its `packages/butler-i18n` key
//! (`taskGraph.*` of `locales/task-graph.ts` unless another is named).
use butler_ds::ui::context::Lang;

pub(crate) struct Words {
    /// taskGraph.title
    pub(crate) title: &'static str,
    /// taskGraph.empty
    pub(crate) empty: &'static str,
    /// taskGraph.status: pending, running, review, done, failed, cancelled, blocked, paused,
    /// skipped
    pub(crate) pending: &'static str,
    pub(crate) running: &'static str,
    pub(crate) review: &'static str,
    pub(crate) done: &'static str,
    pub(crate) failed: &'static str,
    pub(crate) cancelled: &'static str,
    pub(crate) blocked: &'static str,
    pub(crate) paused: &'static str,
    pub(crate) skipped: &'static str,
    /// taskGraph.unassigned, handledDirectly, reviewNotice, resultReceived
    pub(crate) unassigned: &'static str,
    pub(crate) handled_directly: &'static str,
    pub(crate) review_notice: &'static str,
    pub(crate) result_received: &'static str,
    /// taskGraph.detail: attempts, assignee, model, elapsed, after, next, none, step, document,
    /// openDocument, conversation
    pub(crate) attempts_label: &'static str,
    pub(crate) assignee_label: &'static str,
    pub(crate) model: &'static str,
    pub(crate) elapsed_label: &'static str,
    pub(crate) after: &'static str,
    pub(crate) next: &'static str,
    pub(crate) none: &'static str,
    pub(crate) step: &'static str,
    pub(crate) document: &'static str,
    pub(crate) open_document: &'static str,
    pub(crate) conversation: &'static str,
    /// taskGraph.document: goal, criteria, after
    pub(crate) goal: &'static str,
    pub(crate) criteria: &'static str,
    pub(crate) predecessors: &'static str,
    /// guided.workerStatus: orienting, planning, executing, verifying, reporting
    pub(crate) orienting: &'static str,
    pub(crate) planning: &'static str,
    pub(crate) executing: &'static str,
    pub(crate) verifying: &'static str,
    pub(crate) reporting: &'static str,
    /// settings.sectionState: loading, error, retry
    pub(crate) loading: &'static str,
    pub(crate) error: &'static str,
    pub(crate) retry: &'static str,
}

static KO: Words = Words {
    title: "작업 그래프",
    empty: "아직 작업이 없습니다",
    pending: "대기",
    running: "진행 중",
    review: "검토 중",
    done: "완료",
    failed: "실패",
    cancelled: "취소됨",
    blocked: "보류",
    paused: "일시정지",
    skipped: "건너뜀",
    unassigned: "배정 전",
    handled_directly: "직접 처리",
    review_notice: "검토 후 다시 진행",
    result_received: "결과 검토 대기",
    attempts_label: "시도",
    assignee_label: "담당",
    model: "모델",
    elapsed_label: "걸린 시간",
    after: "앞선 작업",
    next: "다음 작업",
    none: "없음",
    step: "지금 하는 일",
    document: "작업 문서",
    open_document: "열기",
    conversation: "대화 보기",
    goal: "목표",
    criteria: "완료 기준",
    predecessors: "앞선 작업",
    orienting: "구상 중",
    planning: "계획 중",
    executing: "작업 중",
    verifying: "검토 중",
    reporting: "보고 중",
    loading: "불러오는 중",
    error: "이 섹션을 불러오지 못했습니다.",
    retry: "다시 시도",
};

static EN: Words = Words {
    title: "Task graph",
    empty: "No tasks yet",
    pending: "Waiting",
    running: "Running",
    review: "In review",
    done: "Done",
    failed: "Failed",
    cancelled: "Cancelled",
    blocked: "Blocked",
    paused: "Paused",
    skipped: "Skipped",
    unassigned: "Not assigned",
    handled_directly: "Handled directly",
    review_notice: "Sent back after review",
    result_received: "Result awaiting review",
    attempts_label: "Attempts",
    assignee_label: "Assignee",
    model: "Model",
    elapsed_label: "Time",
    after: "After",
    next: "Next",
    none: "None",
    step: "Now",
    document: "Task document",
    open_document: "Open",
    conversation: "View conversation",
    goal: "Goal",
    criteria: "Done when",
    predecessors: "After",
    orienting: "Thinking",
    planning: "Planning",
    executing: "Working",
    verifying: "Reviewing",
    reporting: "Reporting",
    loading: "Loading",
    error: "Could not load this section.",
    retry: "Retry",
};

pub(crate) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

/// taskGraph.doneCount
pub(crate) fn done_count(lang: Lang, done: u64, total: u64) -> String {
    match lang {
        Lang::Ko => format!("{done}/{total} 완료"),
        Lang::En => format!("{done}/{total} done"),
    }
}

/// taskGraph.failedCount
pub(crate) fn failed_count(lang: Lang, count: u64) -> String {
    match lang {
        Lang::Ko => format!("실패 {count}"),
        Lang::En => format!("{count} failed"),
    }
}

/// taskGraph.cancelledCount
pub(crate) fn cancelled_count(lang: Lang, count: u64) -> String {
    match lang {
        Lang::Ko => format!("취소 {count}"),
        Lang::En => format!("{count} cancelled"),
    }
}

/// taskGraph.assignee
pub(crate) fn assignee(lang: Lang, ordinal: u64) -> String {
    match lang {
        Lang::Ko => format!("작업자 {ordinal}"),
        Lang::En => format!("Worker {ordinal}"),
    }
}

/// taskGraph.attempts
pub(crate) fn attempts(lang: Lang, count: usize) -> String {
    match lang {
        Lang::Ko => format!("{count}회째"),
        Lang::En => format!("attempt {count}"),
    }
}

/// taskGraph.graphsSummary
pub(crate) fn graphs_summary(lang: Lang, total: usize, running: usize) -> String {
    match lang {
        Lang::Ko if running > 0 => format!("그래프 {total}개 · 진행 중 {running}"),
        Lang::Ko => format!("그래프 {total}개"),
        Lang::En if running > 0 => format!("{total} graphs · {running} running"),
        Lang::En => format!("{total} graphs"),
    }
}

/// taskGraph.elapsed
pub(crate) fn elapsed(lang: Lang, seconds: i64) -> String {
    let s = seconds.max(0);
    let (m, h) = (s / 60, s / 3600);
    match lang {
        Lang::Ko if s < 60 => format!("{s}초"),
        Lang::Ko if m < 60 => format!("{m}분 {:02}초", s % 60),
        Lang::Ko => format!("{h}시간 {}분", m % 60),
        Lang::En if s < 60 => format!("{s}s"),
        Lang::En if m < 60 => format!("{m}m {:02}s", s % 60),
        Lang::En => format!("{h}h {}m", m % 60),
    }
}
