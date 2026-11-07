//! The `appCopy` strings the progress projections and the status rows read, and the
//! `copy.ts` label functions over them (`interfaceProgressLabel`, `localizeProgressRow`,
//! `interfaceText`).
use butler_ds::ui::context::Lang;

use super::tool_titles;
use crate::ui::source::wire::{
    InterfaceContentReferences, InterfaceTextReference, InterfaceTextReferenceKey, ProgressRow,
};

/// `interfaceStatus`, `interfaceDetails`, `conversation.work` and `progress` of the catalog.
pub(crate) struct Strings {
    pub(crate) working: &'static str,
    pub(crate) completed: &'static str,
    pub(crate) failed: &'static str,
    pub(crate) stopped: &'static str,
    pub(crate) conception: &'static str,
    pub(crate) conception_review: &'static str,
    pub(crate) planning: &'static str,
    pub(crate) planning_review: &'static str,
    pub(crate) execution: &'static str,
    pub(crate) task_review: &'static str,
    pub(crate) validation: &'static str,
    pub(crate) feedback: &'static str,
    pub(crate) consolidation: &'static str,
    pub(crate) reporting: &'static str,
    pub(crate) delivered: &'static str,
    pub(crate) failed_past: &'static str,
    pub(crate) cancelled: &'static str,
    pub(crate) idle: &'static str,
    pub(crate) progress: &'static str,
    pub(crate) generating: &'static str,
    pub(crate) approval_waiting: &'static str,
    pub(crate) sign_in_waiting: &'static str,
    pub(crate) tab_waiting: &'static str,
    pub(crate) answer_waiting: &'static str,
    pub(crate) worker_activity: &'static str,
    pub(crate) pending_accepted: &'static str,
    pub(crate) pending_waiting_for_children: &'static str,
    pub(crate) storage_recovery: &'static str,
    pub(crate) reconnecting: &'static str,
    pub(crate) stopping: &'static str,
    pub(crate) progress_fallback: &'static str,
    pub(crate) checking_previous: &'static str,
    pub(crate) checking_request: &'static str,
    pub(crate) tool_working: &'static str,
    pub(crate) checking_information: &'static str,
    pub(crate) command_executing: &'static str,
    pub(crate) conception_title: &'static str,
    pub(crate) planning_next: &'static str,
    pub(crate) report_title: &'static str,
    /// `guided.tools.start_work`.
    pub(crate) start_work: &'static str,
    /// `interfaceStatus.workerCall`, `search`, `lookup`, `edit`, `command`, `read`, `review`.
    pub(crate) worker_call: &'static str,
    pub(crate) search: &'static str,
    pub(crate) lookup: &'static str,
    pub(crate) edit: &'static str,
    pub(crate) command: &'static str,
    pub(crate) read: &'static str,
    pub(crate) review: &'static str,
    /// `guided.workerStatus`, in this order: waiting, orienting, planning, verifying,
    /// reporting, complete, blocked, failed, cancelled, recoverable, executing, approval,
    /// waiting_for_form, delivered, interrupted, waitingForChildren.
    worker_status: [&'static str; 16],
}

const WORKER_STATUS_KEYS: [&str; 16] = [
    "waiting",
    "orienting",
    "planning",
    "verifying",
    "reporting",
    "complete",
    "blocked",
    "failed",
    "cancelled",
    "recoverable",
    "executing",
    "approval",
    "waiting_for_form",
    "delivered",
    "interrupted",
    "waitingForChildren",
];

const EN: Strings = Strings {
    working: "Working",
    completed: "Completed",
    failed: "Failed",
    stopped: "Stopped",
    conception: "Conception",
    conception_review: "Conception review",
    planning: "Planning",
    planning_review: "Plan review",
    execution: "Execution",
    task_review: "Task review",
    validation: "Completion review",
    feedback: "Applying feedback",
    consolidation: "Consolidation",
    reporting: "Reporting",
    delivered: "Completed",
    failed_past: "Failed",
    cancelled: "Stopped",
    idle: "Waiting",
    progress: "Work in progress",
    generating: "Generating response",
    approval_waiting: "Waiting for approval.",
    sign_in_waiting: "Waiting for you to finish signing in.",
    tab_waiting: "Waiting for you to finish in the tab.",
    answer_waiting: "Waiting for your answer.",
    worker_activity: "Working",
    pending_accepted: "Request accepted.",
    pending_waiting_for_children: "Waiting for Worker results.",
    storage_recovery: "Coordinating storage writes",
    reconnecting: "Reconnecting",
    stopping: "Stopping the request",
    progress_fallback: "Working: using the planned tool",
    checking_previous: "Checking previous work and its current state.",
    checking_request: "Clarifying the request and required outcome.",
    tool_working: "Working with tools.",
    checking_information: "Checking information needed for the work.",
    command_executing: "Running the required workspace commands.",
    conception_title: "Confirm request intent",
    planning_next: "Define the work order and validation criteria for the request.",
    report_title: "Report results",
    start_work: "Check request",
    worker_call: "Delegated work",
    search: "Search",
    lookup: "Read",
    edit: "Edit",
    command: "Command",
    read: "Read",
    review: "Review",
    worker_status: [
        "Waiting",
        "Thinking",
        "Planning",
        "Reviewing",
        "Reporting",
        "Complete",
        "Blocked",
        "Failed",
        "Cancelled",
        "Ready to resume",
        "Working",
        "Awaiting approval",
        "Waiting for your approval.",
        "Work completed.",
        "Work was interrupted. You can resume it.",
        "Waiting for worker results.",
    ],
};

const KO: Strings = Strings {
    working: "작업 중",
    completed: "완료",
    failed: "실패",
    stopped: "중단",
    conception: "구상",
    conception_review: "구상 검토",
    planning: "계획",
    planning_review: "계획 검토",
    execution: "실행",
    task_review: "작업 리뷰",
    validation: "완료 검토",
    feedback: "피드백 반영",
    consolidation: "통합 점검",
    reporting: "보고",
    delivered: "완료됨",
    failed_past: "실패함",
    cancelled: "중단됨",
    idle: "대기 중",
    progress: "작업 진행 중",
    generating: "응답 생성 중",
    approval_waiting: "허용 여부를 기다리고 있습니다.",
    sign_in_waiting: "로그인 확인을 기다리고 있습니다.",
    tab_waiting: "탭에서 마치기를 기다리고 있습니다.",
    answer_waiting: "답변을 기다리고 있습니다.",
    worker_activity: "작업 중",
    pending_accepted: "요청을 접수했습니다.",
    pending_waiting_for_children: "작업자 결과를 기다리는 중입니다.",
    storage_recovery: "저장소 쓰기 순서를 조정하고 있습니다",
    reconnecting: "재연결 중",
    stopping: "요청을 중지하고 있습니다",
    progress_fallback: "작업: 계획한 도구를 사용 중",
    checking_previous: "이전에 진행하던 내용과 현재 상태를 확인하고 있습니다.",
    checking_request: "요청하신 내용과 필요한 결과를 정리하고 있습니다.",
    tool_working: "도구 작업을 진행하고 있습니다",
    checking_information: "작업에 필요한 정보를 확인하고 있습니다.",
    command_executing: "작업 공간에서 필요한 명령을 실행하고 있습니다.",
    conception_title: "요청 의도 확인",
    planning_next: "요청에 맞는 작업 순서와 검증 기준을 정합니다.",
    report_title: "결과 보고",
    start_work: "요청 내용 확인",
    worker_call: "작업 위임",
    search: "검색",
    lookup: "조회",
    edit: "편집",
    command: "명령",
    read: "읽기",
    review: "검토",
    worker_status: [
        "대기",
        "구상 중",
        "계획 중",
        "검토 중",
        "보고 중",
        "완료",
        "진행이 막힘",
        "실패",
        "취소됨",
        "이어서 진행 가능",
        "작업 중",
        "허용 대기 중",
        "허용 여부를 기다리고 있습니다.",
        "작업을 완료했습니다.",
        "작업이 중단되었습니다. 이어서 진행할 수 있습니다.",
        "작업자 결과를 기다리는 중입니다.",
    ],
};

pub(crate) fn copy(lang: Lang) -> &'static Strings {
    match lang {
        Lang::En => &EN,
        Lang::Ko => &KO,
    }
}

impl Strings {
    /// `guided.workerStatus[phase]`, `executing` for an unknown phase.
    fn worker_status(&self, phase: &str) -> &'static str {
        let at = WORKER_STATUS_KEYS
            .iter()
            .position(|key| *key == phase)
            .unwrap_or(10);
        self.worker_status[at]
    }
}

/// `formatInterfaceText`: the text a template reference names.
pub(crate) fn interface_text(lang: Lang, reference: &InterfaceTextReference) -> String {
    let copy = copy(lang);
    let parameters = reference.parameters.as_ref();
    let text = parameters.and_then(|p| p.text.as_deref());
    let tool_title = |name: &str, target: Option<&str>| -> String {
        if name == "run_command"
            && let Some(target) = target
            && !target.is_empty()
        {
            return target.to_string();
        }
        let title =
            tool_titles::tool(lang, name).unwrap_or_else(|| tool_titles::tool_fallback(lang));
        match target {
            Some(target) if !target.is_empty() => format!("{title}: {target}"),
            _ => title.to_string(),
        }
    };
    match reference.key {
        InterfaceTextReferenceKey::WorkerStatus => copy
            .worker_status(
                parameters
                    .and_then(|p| p.phase.as_deref())
                    .unwrap_or("executing"),
            )
            .to_string(),
        InterfaceTextReferenceKey::ToolTitle => tool_title(
            parameters
                .and_then(|p| p.toolName.as_deref())
                .unwrap_or("fallback"),
            parameters.and_then(|p| p.target.as_deref()),
        ),
        InterfaceTextReferenceKey::ToolsSummary => {
            let mut titles: Vec<String> = Vec::new();
            for tool in parameters
                .and_then(|p| p.tools.as_ref())
                .into_iter()
                .flatten()
            {
                let title = tool_title(&tool.name, tool.target.as_deref());
                if !titles.contains(&title) {
                    titles.push(title);
                }
            }
            tools_summary(lang, &titles.join(" · "))
        }
        InterfaceTextReferenceKey::ConceptionSummary => {
            conception_summary(lang, text.unwrap_or(""))
        }
        InterfaceTextReferenceKey::WorkInProgress => work_in_progress(lang, text.unwrap_or("")),
        InterfaceTextReferenceKey::CheckingPrevious => copy.checking_previous.to_string(),
        InterfaceTextReferenceKey::CheckingRequest => copy.checking_request.to_string(),
        InterfaceTextReferenceKey::ToolWorking => copy.tool_working.to_string(),
        InterfaceTextReferenceKey::CheckingInformation => copy.checking_information.to_string(),
        InterfaceTextReferenceKey::CommandExecuting => copy.command_executing.to_string(),
        InterfaceTextReferenceKey::ConceptionTitle => copy.conception_title.to_string(),
        InterfaceTextReferenceKey::PlanningNext => copy.planning_next.to_string(),
        InterfaceTextReferenceKey::ReportTitle => copy.report_title.to_string(),
        InterfaceTextReferenceKey::Unknown => String::new(),
    }
}

fn tools_summary(lang: Lang, text: &str) -> String {
    match (lang, text.is_empty()) {
        (Lang::En, true) => "Working with the required tools.".to_string(),
        (Lang::En, false) => format!("Checking the required information with {text}."),
        (Lang::Ko, true) => "필요한 도구로 작업을 진행하고 있습니다.".to_string(),
        (Lang::Ko, false) => format!("{text} 도구로 필요한 정보를 확인하고 있습니다."),
    }
}

fn conception_summary(lang: Lang, text: &str) -> String {
    match (lang, text.is_empty()) {
        (Lang::En, true) => "Confirmed the request goal and scope.".to_string(),
        (Lang::En, false) => format!("Confirmed the request goal and scope: {text}"),
        (Lang::Ko, true) => "요청의 목표와 범위를 확인했습니다.".to_string(),
        (Lang::Ko, false) => format!("요청의 목표와 범위를 확인했습니다: {text}"),
    }
}

fn work_in_progress(lang: Lang, text: &str) -> String {
    match lang {
        Lang::En => format!("Working on {text}."),
        Lang::Ko => format!("{text} 작업을 진행하고 있습니다."),
    }
}

/// `getInterfaceProgressLabel`.
fn interface_progress_key_label(lang: Lang, row: &ProgressRow) -> Option<String> {
    let copy = copy(lang);
    let key = row.interface_label_key.as_deref()?;
    if let Some(name) = key.strip_prefix("operation:") {
        return Some(
            tool_titles::operation(lang, name)
                .unwrap_or(copy.progress_fallback)
                .to_string(),
        );
    }
    match key {
        "working" => Some(copy.working.to_string()),
        "accepted" => Some(copy.pending_accepted.to_string()),
        "generating" => Some(copy.generating.to_string()),
        "storageRecovery" => Some(copy.storage_recovery.to_string()),
        "reconnecting" => Some(match &row.interface_label_parameters {
            Some(p) => format!("{} ({}/{})", copy.reconnecting, p.attempt, p.maxAttempts),
            None => copy.reconnecting.to_string(),
        }),
        "stopping" => Some(copy.stopping.to_string()),
        _ => None,
    }
}

/// `interfaceProgressLabel`: the row's label in the interface language.
pub(crate) fn interface_progress_label(lang: Lang, row: &ProgressRow) -> String {
    let content = row.interface_content.as_ref();
    let reference = content.and_then(|c| c.summary.as_ref()).or_else(|| {
        if row
            .work_decision_summary
            .as_deref()
            .unwrap_or("")
            .is_empty()
        {
            content.and_then(|c| c.title.as_ref())
        } else {
            None
        }
    });
    if let Some(reference) = reference {
        return interface_text(lang, reference);
    }
    interface_progress_key_label(lang, row)
        .or_else(|| tool_titles::tool(lang, &row.safe_label).map(str::to_string))
        .unwrap_or_else(|| row.safe_label.clone())
}

/// `localizeProgressRow`.
pub(crate) fn localize_progress_row(lang: Lang, row: &ProgressRow) -> ProgressRow {
    let content: Option<&InterfaceContentReferences> = row.interface_content.as_ref();
    let label = interface_progress_label(lang, row);
    if content.is_none() && row.interface_label_key.is_none() && label == row.safe_label {
        return row.clone();
    }
    let mut next = row.clone();
    next.safe_label = label;
    if let Some(title) = content.and_then(|c| c.title.as_ref()) {
        let title = interface_text(lang, title);
        next.work_decision_title = Some(title.clone());
        next.work_block_label = Some(title);
    }
    if let Some(summary) = content.and_then(|c| c.summary.as_ref()) {
        next.work_decision_summary = Some(interface_text(lang, summary));
    }
    if let Some(step) = content.and_then(|c| c.nextStep.as_ref()) {
        next.work_decision_next_step = Some(interface_text(lang, step));
    }
    next
}

/// `publicOperationTitle`.
pub(crate) fn public_operation_title(lang: Lang, capability: Option<&str>) -> String {
    let name = capability.map_or("", str::trim);
    tool_titles::operation(lang, name)
        .or_else(|| tool_titles::tool(lang, name))
        .unwrap_or(copy(lang).progress_fallback)
        .to_string()
}

/// `appCopy.guided.tools[name] ?? appCopy.guided.tools.fallback`.
pub(crate) fn tool_title(lang: Lang, name: &str) -> String {
    tool_titles::tool(lang, name)
        .unwrap_or_else(|| tool_titles::tool_fallback(lang))
        .to_string()
}

/// `appCopy.guided.tools.fallback`.
pub(crate) fn tool_fallback(lang: Lang) -> &'static str {
    tool_titles::tool_fallback(lang)
}
