//! The copy of System events. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(crate) struct Words {
    /// settings.pageSections.systemEvents
    pub(crate) title: &'static str,
    /// settings.descriptions.systemEvents
    pub(crate) description: &'static str,
    /// settings.descriptions.systemEventsEmpty
    pub(crate) empty: &'static str,
    /// common.refresh
    pub(crate) refresh: &'static str,
    /// common.more
    pub(crate) more: &'static str,
    /// settings.options.consolidationModelDefault
    pub(crate) model_default: &'static str,
    /// settings.systemEventLabels.titles: profile, consolidation, sessionSync, contextMaintenance,
    /// consolidationCycle
    pub(crate) titles: [&'static str; 5],
    /// settings.systemEventLabels.statuses: ok, completed, failed, running, notRun, unknown
    pub(crate) statuses: [&'static str; 6],
    /// settings.systemEventLabels.metrics, by metric label
    pub(crate) metrics: [(&'static str, &'static str); 15],
    /// settings.systemEventLabels.values: yes, no, deep, basic, off
    pub(crate) values: [&'static str; 5],
}

const KO: Words = Words {
    title: "최근 이벤트",
    description: "정기 정리, 알아가기, 유지보수 작업이 언제 어떻게 끝났는지 확인합니다.",
    empty: "아직 표시할 시스템 이벤트가 없습니다.",
    refresh: "새로고침",
    more: "더보기",
    model_default: "모델 기본값",
    titles: [
        "알아가기",
        "대화 기억 정리",
        "대화 기록 반영",
        "컨텍스트 정리",
        "정기 기억 정리",
    ],
    statuses: [
        "성공",
        "완료",
        "실패",
        "실행 중",
        "아직 실행 전",
        "상태 확인 필요",
    ],
    metrics: [
        ("phase_count", "단계"),
        ("failed_phase_count", "실패 단계"),
        ("profiling_enabled", "알아가기"),
        ("mode", "모드"),
        ("candidate_count", "후보"),
        ("promoted_count", "반영"),
        ("skipped_count", "제외"),
        ("stable_entry_count", "저장된 프로필"),
        ("projection_written", "투영본 갱신"),
        ("transcript_scanned_file_count", "읽은 대화 파일"),
        ("transcript_scanned_event_count", "읽은 이벤트"),
        ("transcript_captured_candidate_count", "대화에서 찾은 후보"),
        ("transcript_extractor_model_called", "모델 호출"),
        ("transcript_extractor_fallback_used", "대체 경로"),
        ("last_run_date", "실행일"),
    ],
    values: ["예", "아니오", "깊게", "기본", "끔"],
};

const EN: Words = Words {
    title: "Recent events",
    description: "Review regular consolidation, profile building, and maintenance work.",
    empty: "No system events to show yet.",
    refresh: "Refresh",
    more: "More",
    model_default: "Model default",
    titles: [
        "Profile building",
        "Chat memory consolidation",
        "Conversation history sync",
        "Context maintenance",
        "Regular memory consolidation",
    ],
    statuses: [
        "OK",
        "Completed",
        "Failed",
        "Running",
        "Not run yet",
        "Needs status check",
    ],
    metrics: [
        ("phase_count", "Phases"),
        ("failed_phase_count", "Failed phases"),
        ("profiling_enabled", "Profile building"),
        ("mode", "Mode"),
        ("candidate_count", "Candidates"),
        ("promoted_count", "Applied"),
        ("skipped_count", "Skipped"),
        ("stable_entry_count", "Stored profile"),
        ("projection_written", "Projection updated"),
        ("transcript_scanned_file_count", "Conversation files read"),
        ("transcript_scanned_event_count", "Events read"),
        ("transcript_captured_candidate_count", "Candidates found"),
        ("transcript_extractor_model_called", "Model called"),
        ("transcript_extractor_fallback_used", "Fallback used"),
        ("last_run_date", "Run date"),
    ],
    values: ["Yes", "No", "Deep", "Basic", "Off"],
};

pub(crate) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
