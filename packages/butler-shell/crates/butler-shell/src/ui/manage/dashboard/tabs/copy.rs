//! The copy of the dashboard's materials, results, history and statistics panels. Each field
//! names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// feedback.retry
    pub(super) retry: &'static str,
    /// feedback.dashboardRetry
    pub(super) dashboard_retry: &'static str,
    /// feedback.dashboardLoading
    pub(super) dashboard_loading: &'static str,
    /// interfaceDetails.noDocuments
    pub(super) no_documents: &'static str,
    /// projectSignpost.unavailable
    pub(super) unavailable: &'static str,
    /// projectSignpost.importantMaterials
    pub(super) important_materials: &'static str,
    /// projectSignpost.projectDocuments
    pub(super) project_documents: &'static str,
    /// projectSignpost.missingSource
    pub(super) missing_source: &'static str,
    /// projectSignpost.loadMore
    pub(super) load_more: &'static str,
    /// projectSignpost.pin
    pub(super) pin: &'static str,
    /// projectSignpost.unpin
    pub(super) unpin: &'static str,
    /// projectSignpost.results
    pub(super) results: &'static str,
    /// projectSignpost.noResults
    pub(super) no_results: &'static str,
    /// projectSignpost.historyLedgerUnavailable
    pub(super) ledger_unavailable: &'static str,
    /// projectSignpost.noHistory
    pub(super) no_history: &'static str,
    /// projectSignpost.recordedCompletion
    pub(super) recorded_completion: &'static str,
    /// projectSignpost.created, updated, reported, reviewed, disposition, result
    action: [&'static str; 6],
    /// projectSignpost.linkedResults
    pub(super) linked_results: fn(i64) -> String,
    /// projectSignpost.period
    pub(super) period: &'static str,
    /// projectSignpost.periodDays
    pub(super) period_days: fn(u32) -> String,
    /// projectSignpost.statisticsZone
    pub(super) statistics_zone: fn(&str) -> String,
    /// projectSignpost.statisticsKind
    pub(super) statistics_kind: &'static str,
    /// projectSignpost.materialsView
    pub(super) materials_view: &'static str,
    /// projectSignpost.noRemaining
    pub(super) no_remaining: &'static str,
    /// projectDocumentMetadata.document
    document: &'static str,
    /// projectDocumentMetadata.roadmap
    roadmap: &'static str,
    /// projectSignpost.history (the badge of a reference)
    reference: &'static str,
    /// interfaceStatus.work, task, spec, report; composer.plan
    work: &'static str,
    task: &'static str,
    spec: &'static str,
    report: &'static str,
    plan: &'static str,
    pub(super) stats: StatWords,
}

/// `projectStatistics`
pub(super) struct StatWords {
    pub(super) flow: &'static str,
    pub(super) flow_help: &'static str,
    pub(super) remaining: &'static str,
    pub(super) remaining_help: &'static str,
    pub(super) aging: &'static str,
    pub(super) aging_help: &'static str,
    pub(super) calendar: &'static str,
    pub(super) active_items: fn(usize) -> String,
    pub(super) work_overview: &'static str,
    pub(super) loading: fn(u32) -> String,
    pub(super) refreshing: &'static str,
    pub(super) load_failed: &'static str,
    pub(super) focus: &'static str,
    pub(super) materials: &'static str,
    pub(super) materials_help: &'static str,
    pub(super) outcomes: &'static str,
    pub(super) outcomes_help: &'static str,
    pub(super) duration: &'static str,
    pub(super) duration_help: &'static str,
    pub(super) usage: &'static str,
    pub(super) usage_help: &'static str,
    pub(super) empty: &'static str,
    pub(super) unavailable: &'static str,
    pub(super) history_unavailable: &'static str,
    pub(super) session_unavailable: &'static str,
    pub(super) task_completion_unavailable: &'static str,
    pub(super) selected: &'static str,
    pub(super) all: &'static str,
    pub(super) partial_day: &'static str,
    pub(super) excluded: fn(i64) -> String,
    pub(super) age: fn(i64) -> String,
    pub(super) changes: fn(i64) -> String,
    pub(super) sources: fn(usize) -> String,
    /// projectStatistics.labels
    labels: fn(&str) -> Option<&'static str>,
}

impl StatWords {
    /// `copy.labels[key]`
    pub(super) fn label(&self, key: &str) -> Option<&'static str> {
        (self.labels)(key)
    }

    /// `copy.labels[key] ?? key`
    pub(super) fn label_or(&self, key: &str) -> String {
        self.label(key)
            .map_or_else(|| key.to_owned(), str::to_owned)
    }
}

impl Words {
    /// `copy[event.action]` of a history event.
    pub(super) fn action(&self, action: &str) -> &'static str {
        let index = [
            "created",
            "updated",
            "reported",
            "reviewed",
            "disposition",
            "result",
        ]
        .iter()
        .position(|name| *name == action);
        index.map_or("", |index| self.action[index])
    }

    /// `projectDocumentBadgeLabel` of a document type.
    pub(super) fn badge(&self, kind: &str) -> &'static str {
        match kind {
            "artifact" => self.results,
            "task" => self.task,
            "plan" => self.plan,
            "roadmap" => self.roadmap,
            "spec" => self.spec,
            "report" | "message" => self.report,
            "reference" => self.reference,
            _ => self.document,
        }
    }

    /// interfaceStatus.task
    pub(super) fn task(&self) -> &'static str {
        self.task
    }

    /// interfaceStatus.work
    pub(super) fn work(&self) -> &'static str {
        self.work
    }
}

fn ko_label(key: &str) -> Option<&'static str> {
    Some(match key {
        "types" => "종류별",
        "changes" => "변경별",
        "spec" => "명세",
        "plan" => "계획",
        "report" => "보고서",
        "created" => "등록",
        "completed" => "완료 기록",
        "executed" => "실행 완료",
        "updated" => "수정",
        "artifacts" => "전달된 첨부",
        "conversations" => "대화",
        "work" => "작업 변경",
        "materials" => "자료",
        "planned" => "예정",
        "active" => "진행",
        "review" => "검토",
        "blocked" => "막힘",
        "other" => "기타·확인 불가",
        "delivered" => "답변 완료",
        "failed" => "실패",
        "cancelled" => "중단",
        "under30s" => "30초 미만",
        "under2m" => "30초~2분",
        "under10m" => "2~10분",
        "over10m" => "10분 이상",
        "recent" => "0~7일",
        "older" => "8~30일",
        "oldest" => "31일 이상",
        "unknown" => "시각 확인 불가",
        _ => return None,
    })
}

fn en_label(key: &str) -> Option<&'static str> {
    Some(match key {
        "types" => "By type",
        "changes" => "Changes",
        "spec" => "Specifications",
        "plan" => "Plans",
        "report" => "Reports",
        "created" => "Registered",
        "completed" => "Completion recorded",
        "executed" => "Execution completed",
        "updated" => "Updated",
        "artifacts" => "Published attachments",
        "conversations" => "Conversations",
        "work" => "Work changes",
        "materials" => "Materials",
        "planned" => "Planned",
        "active" => "In progress",
        "review" => "In review",
        "blocked" => "Blocked",
        "other" => "Other / unconfirmed",
        "delivered" => "Reply completed",
        "failed" => "Failed",
        "cancelled" => "Stopped",
        "under30s" => "Under 30 sec",
        "under2m" => "30 sec–2 min",
        "under10m" => "2–10 min",
        "over10m" => "10 min or more",
        "recent" => "0–7 days",
        "older" => "8–30 days",
        "oldest" => "31+ days",
        "unknown" => "Date unknown",
        _ => return None,
    })
}

static KO: Words = Words {
    retry: "다시 시도",
    dashboard_retry: "연결을 확인한 뒤 다시 시도해 주세요.",
    dashboard_loading: "프로젝트 정보를 불러오는 중입니다.",
    no_documents: "프로젝트 문서가 없습니다.",
    unavailable: "프로젝트 기록을 확인하지 못했습니다. 완료 여부를 추정하지 않습니다.",
    important_materials: "중요한 자료",
    project_documents: "프로젝트 문서",
    missing_source: "고정한 자료를 찾을 수 없습니다.",
    load_more: "더 보기",
    pin: "주요 자료로 고정",
    unpin: "고정 해제",
    results: "공개된 결과 자료",
    no_results: "대화에서 공개된 결과 자료가 아직 없습니다.",
    ledger_unavailable: "프로젝트 기록 이력은 확인하지 못했습니다. 대화에서 전달된 공개 답변만 표시합니다.",
    no_history: "아직 기록이 없습니다.",
    recorded_completion: "완료 기록",
    action: [
        "생성",
        "갱신",
        "공개 답변",
        "검토 기록",
        "상태 판정 기록",
        "도구 결과 등록",
    ],
    linked_results: |count| format!("결과 자료 {count}개"),
    period: "기간",
    period_days: |days| format!("최근 {days}일"),
    statistics_zone: |zone| format!("{zone} 날짜 기준"),
    statistics_kind: "집계 기준",
    materials_view: "자료 보기",
    no_remaining: "기록상 남아 있는 작업이 없습니다.",
    document: "문서",
    roadmap: "로드맵",
    reference: "기록",
    work: "작업",
    task: "하위 작업",
    spec: "스펙",
    report: "보고서",
    plan: "계획",
    stats: StatWords {
        flow: "작업이 어떻게 달라졌나요",
        flow_help: "등록한 일과 완료가 기록된 일입니다. 개수의 차이가 프로젝트 전체 진척을 뜻하지는 않습니다.",
        remaining: "남은 일은 어디에 있나요",
        remaining_help: "선택한 기간과 관계없이 현재 작업 보드의 단계를 보여줍니다.",
        aging: "다시 살펴볼 일",
        aging_help: "마지막 갱신 이후 경과일입니다. 실제 작업 시간이나 대기 시간은 아닙니다.",
        calendar: "프로젝트 활동",
        active_items: |count| format!("총 {count}개"),
        work_overview: "작업 현황",
        loading: |days| format!("최근 {days}일 통계를 불러오고 있습니다…"),
        refreshing: "통계를 업데이트하고 있습니다…",
        load_failed: "통계 응답을 받지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.",
        focus: "어떤 일을 다뤘나요",
        materials: "자료와 결과물의 변화",
        materials_help: "날짜별 문서 등록·수정과 새로 전달된 첨부입니다. 같은 문서의 하루 여러 번 수정은 한 건으로 셉니다.",
        outcomes: "버틀러 요청 결과",
        outcomes_help: "종료 이벤트가 기록된 요청을 종료일 기준으로 보여줍니다. 답변 완료가 프로젝트 작업 완료를 뜻하지는 않습니다.",
        duration: "요청 처리에 걸린 시간",
        duration_help: "요청 생성부터 기록된 종료 상태까지, 대기를 포함한 경과 시간입니다. 사람의 작업 시간이나 순수 모델 실행 시간은 아닙니다.",
        usage: "모델 사용량",
        usage_help: "이 화면에 연결된 프로젝트별 토큰·비용 기록은 아직 없습니다. 미수집은 사용량 0이 아니며, 구독 사용량을 API 요금으로 환산하지 않습니다.",
        empty: "선택한 범위에 기록이 없습니다.",
        unavailable: "이 데이터를 확인할 수 없습니다.",
        history_unavailable: "프로젝트 기록 전체 이력을 읽지 못해 작업·문서 추이는 집계하지 않습니다.",
        session_unavailable: "대화 이력을 읽지 못해 대화 활동·전달된 첨부·요청 결과는 집계하지 않습니다.",
        task_completion_unavailable: "하위 작업 완료 시각은 기존 프로젝트 기록에 별도로 남지 않아 완료 추이를 집계할 수 없습니다. 등록 추이와 현재 단계만 표시합니다.",
        selected: "선택한 기록",
        all: "전체",
        partial_day: "오늘은 현재까지의 기록입니다.",
        excluded: |count| format!("근거가 충분하지 않은 기록 {count}개 제외"),
        age: |days| format!("갱신 후 {days}일"),
        changes: |count| format!("변경 {count}건"),
        sources: |count| format!("기록 {count}개"),
        labels: ko_label,
    },
};

static EN: Words = Words {
    retry: "Try again",
    dashboard_retry: "Check your connection and try again.",
    dashboard_loading: "Loading project information…",
    no_documents: "No project documents.",
    unavailable: "Project records are unavailable. Completion has not been inferred.",
    important_materials: "Important materials",
    project_documents: "Project documents",
    missing_source: "This saved source is unavailable.",
    load_more: "Show more",
    pin: "Pin material",
    unpin: "Unpin material",
    results: "Published results",
    no_results: "No results have been published in project conversations yet.",
    ledger_unavailable: "Project record history is unavailable. Showing delivered conversation replies only.",
    no_history: "No records yet.",
    recorded_completion: "Completion recorded",
    action: [
        "Created",
        "Updated",
        "Published reply",
        "Review recorded",
        "Disposition recorded",
        "Tool result registered",
    ],
    linked_results: |count| format!("{count} published artifacts"),
    period: "Period",
    period_days: |days| format!("Last {days} days"),
    statistics_zone: |zone| format!("Calendar days in {zone}"),
    statistics_kind: "Count by",
    materials_view: "Materials view",
    no_remaining: "No remaining work is recorded.",
    document: "Document",
    roadmap: "Roadmap",
    reference: "History",
    work: "Work",
    task: "Task",
    spec: "Spec",
    report: "Report",
    plan: "Plan",
    stats: StatWords {
        flow: "How work changed",
        flow_help: "Registered work and recorded completions. These counts do not represent overall project progress.",
        remaining: "Where work remains",
        remaining_help: "Current board stages, independent of the selected date range.",
        aging: "Work to revisit",
        aging_help: "Time since the last update, not time spent working or waiting.",
        calendar: "Project activity",
        active_items: |count| format!("{count} items in total"),
        work_overview: "Work overview",
        loading: |days| format!("Loading the last {days} days…"),
        refreshing: "Updating statistics…",
        load_failed: "No statistics response was received. Check your connection and try again.",
        focus: "Where activity went",
        materials: "Materials and results",
        materials_help: "Documents registered or updated each day, and newly published assistant attachments. Repeated daily updates count once per document.",
        outcomes: "Butler request outcomes",
        outcomes_help: "Requests with a recorded terminal event, grouped by that event's date. A completed reply does not mean a completed project task.",
        duration: "Request elapsed time",
        duration_help: "From request creation to the recorded terminal state, including waiting. Not human effort or model-only runtime.",
        usage: "Model usage",
        usage_help: "Project-attributed token and cost data is not collected here yet. Missing usage is not zero, and subscription usage is not an API charge.",
        empty: "No records in this selection.",
        unavailable: "This data is unavailable.",
        history_unavailable: "Full project record history is unavailable. Work and document trends are not counted.",
        session_unavailable: "Conversation history is unavailable. Conversation activity, published attachments, and request outcomes are not counted.",
        task_completion_unavailable: "Existing project records do not store task completion times. Only registrations and current stages are shown.",
        selected: "Selected records",
        all: "All",
        partial_day: "Today includes records so far.",
        excluded: |count| format!("{count} records without sufficient evidence excluded"),
        age: |days| format!("{days} days since update"),
        changes: |count| format!("{count} changes"),
        sources: |count| format!("{count} records"),
        labels: en_label,
    },
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
