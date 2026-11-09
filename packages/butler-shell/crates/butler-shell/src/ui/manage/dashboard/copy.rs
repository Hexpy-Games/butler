//! The copy of the project dashboard frame and overview. Each field names its
//! `packages/butler-i18n` key (`locales/ko.ts`, `locales/en.ts`; `canon.epic` is in `canon.ts`).
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// projectSignpost.overview
    pub(super) tab_overview: &'static str,
    /// projectSignpost.board
    pub(super) tab_work: &'static str,
    /// projectSignpost.materials
    pub(super) tab_materials: &'static str,
    /// projectSignpost.history
    pub(super) tab_history: &'static str,
    /// projectSignpost.statistics
    pub(super) tab_statistics: &'static str,
    /// projectSignpost.description
    pub(super) description: &'static str,
    /// projectSignpost.editDescription
    pub(super) edit_description: &'static str,
    /// projectSignpost.position
    pub(super) position: &'static str,
    /// projectSignpost.suggestions
    pub(super) suggestions: &'static str,
    /// projectSignpost.briefingPending
    pub(super) briefing_pending: &'static str,
    /// projectSignpost.briefingUnavailable
    pub(super) briefing_unavailable: &'static str,
    /// projectSignpost.summarized
    pub(super) summarized: &'static str,
    /// projectSignpost.addToComposer
    pub(super) add_to_composer: &'static str,
    /// projectSignpost.sourceQuestion
    pub(super) source_question: &'static str,
    /// projectSignpost.importantMaterials
    pub(super) important_materials: &'static str,
    /// projectSignpost.importantMaterialsHelp
    pub(super) important_materials_help: &'static str,
    /// projectSignpost.remaining
    pub(super) remaining: &'static str,
    /// projectSignpost.completed
    pub(super) completed: &'static str,
    /// projectSignpost.open
    pub(super) open: &'static str,
    /// projectSignpost.blocked
    pub(super) blocked: &'static str,
    /// projectSignpost.abandoned
    pub(super) abandoned: &'static str,
    /// projectSignpost.unknown
    pub(super) unknown: &'static str,
    /// projectSignpost.registered
    pub(super) registered: &'static str,
    /// projectSignpost.unbound
    pub(super) unbound: &'static str,
    /// projectSignpost.unavailable
    pub(super) unavailable: &'static str,
    /// projectSignpost.noRemaining
    pub(super) no_remaining: &'static str,
    /// projectSignpost.tasks
    pub(super) tasks: &'static str,
    /// projectSignpost.recorded
    pub(super) recorded: &'static str,
    /// projectSignpost.work
    pub(super) work: &'static str,
    /// projectSignpost.loadMore
    pub(super) load_more: &'static str,
    /// projectSignpost.results
    pub(super) results: &'static str,
    /// projectSignpost.evidenceCount
    pub(super) evidence_count: fn(usize) -> String,
    /// projectSignpost.briefingCoverage
    pub(super) briefing_coverage: fn(i64, i64, i64, i64, i64) -> String,
    /// projectSignpost.loaded
    pub(super) loaded: fn(usize, i64) -> String,
    /// feedback.dashboardLoading
    pub(super) dashboard_loading: &'static str,
    /// feedback.dashboardFailed
    pub(super) dashboard_failed: &'static str,
    /// feedback.dashboardRetry
    pub(super) dashboard_retry: &'static str,
    /// feedback.projectMissing
    pub(super) project_missing: &'static str,
    /// feedback.projectMissingHelp
    pub(super) project_missing_help: &'static str,
    /// feedback.retry
    pub(super) retry: &'static str,
    /// interfacePanels.projectDocumentsFailed
    pub(super) documents_failed: &'static str,
    /// interfacePanels.messages7d
    pub(super) messages_7d: &'static str,
    /// interfacePanels.messages30d
    pub(super) messages_30d: &'static str,
    /// interfacePanels.activeSessions
    pub(super) active_sessions: &'static str,
    /// interfacePanels.specs
    pub(super) specs: &'static str,
    /// interfacePanels.plans
    pub(super) plans: &'static str,
    /// interfacePanels.archived
    pub(super) archived: &'static str,
    /// space.newChat
    pub(super) new_chat: &'static str,
    /// sidebar.projectMenu
    pub(super) project_menu: &'static str,
    /// projectSignpost.wallpaper
    pub(super) wallpaper: &'static str,
    /// shell.notYet
    pub(super) not_yet: &'static str,
    /// briefing.projectMoment
    pub(super) project_moment: &'static str,
    /// canon.epic
    pub(super) epic: &'static str,
    /// common.close
    pub(super) close: &'static str,
    /// common.cancel
    pub(super) cancel: &'static str,
    /// common.save
    pub(super) save: &'static str,
    /// interfaceStatus.spec
    pub(super) spec: &'static str,
    /// interfaceStatus.task
    pub(super) task: &'static str,
    /// interfaceStatus.report
    pub(super) report: &'static str,
    /// composer.plan
    pub(super) plan: &'static str,
    /// projectDocumentMetadata.document
    pub(super) document: &'static str,
    /// projectDocumentMetadata.roadmap
    pub(super) roadmap: &'static str,
    /// projectDocumentMetadata.sourceDetails
    pub(super) source_details: &'static str,
    /// projectDocumentMetadata.readOnly
    pub(super) read_only: &'static str,
    /// projectDocumentMetadata.referenceAction
    pub(super) reference_action: &'static str,
    /// projectDocumentMetadata.labels, as (key, label)
    labels: &'static [(&'static str, &'static str)],
    /// projectDocumentMetadata.statuses, as (key, label) (`skipped` is the task graph's)
    statuses: &'static [(&'static str, &'static str)],
    pub(super) lang: Lang,
}

impl Words {
    /// `projectDocumentMetadata.labels[key]`
    pub(super) fn label(&self, key: &str) -> Option<&'static str> {
        find(self.labels, key)
    }

    /// `projectDocumentMetadata.statuses[key]`
    pub(super) fn status(&self, key: &str) -> Option<&'static str> {
        find(self.statuses, key)
    }
}

fn find(table: &'static [(&'static str, &'static str)], key: &str) -> Option<&'static str> {
    table
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, label)| *label)
}

static KO: Words = Words {
    tab_overview: "개요",
    tab_work: "보드",
    tab_materials: "자료",
    tab_history: "기록",
    tab_statistics: "통계",
    description: "프로젝트 소개",
    edit_description: "소개 편집",
    position: "진행 상황",
    suggestions: "다음으로 살펴볼 만한 일",
    briefing_pending: "선정된 기록을 요약하고 있습니다. 자료를 살펴보거나 대화를 시작하실 수 있습니다.",
    briefing_unavailable: "요약을 불러올 수 없습니다. 프로젝트 기록과 대화 입력은 계속 사용할 수 있습니다.",
    summarized: "선정된 기록의 요약이며 새로 검증한 결과가 아닙니다",
    add_to_composer: "이 내용으로 질문하기",
    source_question: "이 자료에서 다음으로 살펴볼 점을 알려주세요. ",
    important_materials: "중요한 자료",
    important_materials_help: "고정한 자료와 남은 작업에 명시적으로 연결된 계획·기준·최신 보고입니다.",
    remaining: "남아 있는 일",
    completed: "실행 완료",
    open: "남은 작업",
    blocked: "막힌 작업",
    abandoned: "종료한 작업",
    unknown: "확인하지 못한 작업",
    registered: "등록된 작업",
    unbound: "이 프로젝트에 연결된 기록이 없습니다.",
    unavailable: "프로젝트 기록을 확인하지 못했습니다. 완료 여부를 추정하지 않습니다.",
    no_remaining: "기록상 남아 있는 작업이 없습니다.",
    tasks: "하위 작업",
    recorded: "등록된 작업 기준",
    work: "작업",
    load_more: "더 보기",
    results: "공개된 결과 자료",
    evidence_count: |count| format!("근거 기록 {count}개 보기"),
    briefing_coverage: |works, total, documents, reports, excluded| {
        format!(
            "작업 {works}/{total}개 · 문서 제목 {documents}개 · 최근 보고 발췌 {reports}개 · 선정 후보 중 제외 {excluded}개 (전체 대화 이력 제외 수는 아님)"
        )
    },
    loaded: |loaded, total| format!("전체 {total}개 중 {loaded}개 표시"),
    dashboard_loading: "프로젝트 정보를 불러오는 중입니다.",
    dashboard_failed: "프로젝트 정보를 불러오지 못했습니다.",
    dashboard_retry: "연결을 확인한 뒤 다시 시도해 주세요.",
    project_missing: "프로젝트를 찾을 수 없습니다.",
    project_missing_help: "사이드바에서 다른 프로젝트를 선택하거나 새 대화를 시작해 주세요.",
    retry: "다시 시도",
    documents_failed: "프로젝트 문서를 불러오지 못했습니다",
    messages_7d: "최근 7일 메시지",
    messages_30d: "최근 30일 메시지",
    active_sessions: "진행 중인 대화",
    specs: "스펙",
    plans: "계획",
    archived: "보관됨",
    new_chat: "새 대화",
    project_menu: "프로젝트 메뉴",
    wallpaper: "월페이퍼",
    not_yet: "준비 중",
    project_moment: "프로젝트",
    epic: "과제",
    close: "닫기",
    cancel: "취소",
    save: "저장",
    spec: "스펙",
    task: "하위 작업",
    report: "보고서",
    plan: "계획",
    document: "문서",
    roadmap: "로드맵",
    source_details: "원본 식별 정보",
    read_only: "원본 문서를 읽기 전용으로 보고 있습니다.",
    reference_action: "대화에 참조하기",
    labels: &[
        ("id", "ID"),
        ("kind", "문서 종류"),
        ("status", "문서 상태"),
        ("updatedAt", "최근 수정"),
        ("source", "원본 위치"),
        ("revision", "리비전"),
        ("migratedFrom", "이전 위치"),
        ("parent", "상위 항목"),
        ("owner", "담당자"),
        ("priority", "우선순위"),
        ("acceptance", "수락 기준"),
        ("validation", "검증"),
        ("review", "리뷰"),
        ("report", "보고"),
        ("implementation", "구현"),
    ],
    statuses: &[
        ("draft", "초안"),
        ("proposed", "제안됨"),
        ("active", "진행 중"),
        ("in_progress", "진행 중"),
        ("todo", "할 일"),
        ("planned", "예정"),
        ("review", "검토 중"),
        ("blocked", "진행이 막힘"),
        ("done", "완료"),
        ("completed", "완료"),
        ("cancelled", "취소됨"),
        ("archived", "보관됨"),
        ("superseded", "대체됨"),
        ("deprecated", "사용 중단"),
    ],
    lang: Lang::Ko,
};

static EN: Words = Words {
    tab_overview: "Overview",
    tab_work: "Board",
    tab_materials: "Materials",
    tab_history: "History",
    tab_statistics: "Statistics",
    description: "Project description",
    edit_description: "Edit description",
    position: "Project status",
    suggestions: "Worth exploring next",
    briefing_pending: "Summarizing the selected records. You can keep browsing or start a conversation.",
    briefing_unavailable: "A summary is unavailable. The project records and conversation composer are still available.",
    summarized: "Summary of selected records, not a new verification",
    add_to_composer: "Ask about this",
    source_question: "What should I look into next based on this source? ",
    important_materials: "Important materials",
    important_materials_help: "Saved materials and plans, specifications, and latest reports explicitly linked to remaining work.",
    remaining: "Remaining work",
    completed: "Execution completed",
    open: "Open work",
    blocked: "Blocked work",
    abandoned: "Abandoned work",
    unknown: "Unverified work",
    registered: "Registered work",
    unbound: "No project records are linked to this project.",
    unavailable: "Project records are unavailable. Completion has not been inferred.",
    no_remaining: "No remaining work is recorded.",
    tasks: "Child Tasks",
    recorded: "Based on registered work",
    work: "Work",
    load_more: "Show more",
    results: "Published results",
    evidence_count: |count| format!("View {count} source records"),
    briefing_coverage: |works, total, documents, reports, excluded| {
        format!(
            "{works} of {total} work records · {documents} document titles · {reports} recent report excerpts · {excluded} candidate units excluded (not the entire conversation history)"
        )
    },
    loaded: |loaded, total| format!("Showing {loaded} of {total}"),
    dashboard_loading: "Loading project information…",
    dashboard_failed: "Could not load project information.",
    dashboard_retry: "Check your connection and try again.",
    project_missing: "Project not found.",
    project_missing_help: "Select another project in the sidebar or start a new chat.",
    retry: "Try again",
    documents_failed: "Project documents failed",
    messages_7d: "7d messages",
    messages_30d: "30d messages",
    active_sessions: "Active sessions",
    specs: "Specs",
    plans: "Plans",
    archived: "Archived",
    new_chat: "New chat",
    project_menu: "Project menu",
    wallpaper: "Wallpaper",
    not_yet: "Coming soon",
    project_moment: "Project",
    epic: "Epic",
    close: "Close",
    cancel: "Cancel",
    save: "Save",
    spec: "Spec",
    task: "Task",
    report: "Report",
    plan: "Plan",
    document: "Document",
    roadmap: "Roadmap",
    source_details: "Source details",
    read_only: "Read-only view of the original document.",
    reference_action: "Reference in conversation",
    labels: &[
        ("id", "ID"),
        ("kind", "Document type"),
        ("status", "Document status"),
        ("updatedAt", "Last updated"),
        ("source", "Source location"),
        ("revision", "Revision"),
        ("migratedFrom", "Migrated from"),
        ("parent", "Parent"),
        ("owner", "Owner"),
        ("priority", "Priority"),
        ("acceptance", "Acceptance"),
        ("validation", "Validation"),
        ("review", "Review"),
        ("report", "Report"),
        ("implementation", "Implementation"),
    ],
    statuses: &[
        ("draft", "Draft"),
        ("proposed", "Proposed"),
        ("active", "Active"),
        ("in_progress", "In progress"),
        ("todo", "To do"),
        ("planned", "Planned"),
        ("review", "In review"),
        ("blocked", "Blocked"),
        ("done", "Done"),
        ("completed", "Completed"),
        ("cancelled", "Cancelled"),
        ("archived", "Archived"),
        ("superseded", "Superseded"),
        ("deprecated", "Deprecated"),
    ],
    lang: Lang::En,
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
