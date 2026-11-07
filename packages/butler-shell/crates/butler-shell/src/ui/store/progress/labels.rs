//! The plan, disclosure and phase labels of `conversation.work` and `interfaceStatus`, and the
//! elapsed-time text.
use butler_ds::ui::context::Lang;

use super::copy::copy;

/// `useElapsedTime`'s text: `interfaceTemplates.elapsed(minutes, seconds)`.
pub(crate) fn elapsed(lang: Lang, total_seconds: u64) -> String {
    let (minutes, seconds) = (total_seconds / 60, total_seconds % 60);
    match lang {
        Lang::En => format!("{minutes}m {seconds}s"),
        Lang::Ko => format!("{minutes}분 {seconds}초"),
    }
}

/// `conversation.work.planSteps.running`.
pub(crate) fn plan_running(lang: Lang, done: usize, total: usize, titles: &str) -> String {
    match (lang, titles.is_empty()) {
        (Lang::En, true) => format!("Done {done}/{total}"),
        (Lang::En, false) => format!("Done {done}/{total} · Now: {titles}"),
        (Lang::Ko, true) => format!("완료 {done}/{total}"),
        (Lang::Ko, false) => format!("완료 {done}/{total} · 지금: {titles}"),
    }
}

/// `conversation.work.planSteps.compact`.
pub(crate) fn plan_compact(lang: Lang, first: &str, more: usize) -> String {
    match lang {
        Lang::En => format!("Now: {first} +{more} more"),
        Lang::Ko => format!("지금: {first} 외 {more}"),
    }
}

/// `conversation.work.planSteps.delivered`.
pub(crate) fn plan_delivered(lang: Lang, done: usize, total: usize) -> String {
    match lang {
        Lang::En => format!("Done · {done}/{total} steps"),
        Lang::Ko => format!("완료됨 · {done}/{total} 단계"),
    }
}

/// `conversation.work.planSteps.failed`.
pub(crate) fn plan_failed(lang: Lang, step: &str) -> String {
    match (lang, step.is_empty()) {
        (Lang::En, true) => "Failed".to_string(),
        (Lang::En, false) => format!("Failed at {step}"),
        (Lang::Ko, true) => "실패함".to_string(),
        (Lang::Ko, false) => format!("실패함 · {step}에서"),
    }
}

/// `phaseLabel`: the label of a phase or settled state.
pub(crate) fn phase_label(lang: Lang, phase: Option<&str>) -> &'static str {
    let copy = copy(lang);
    let Some(phase) = phase.filter(|phase| !phase.is_empty()) else {
        return copy.working;
    };
    match phase {
        "delivered" | "completed" => copy.completed,
        "failed" | "runtime_fault" => copy.failed,
        "cancelled" => copy.stopped,
        _ if phase.starts_with("conception") => copy.conception,
        "contract_review" => copy.conception_review,
        "planning" => copy.planning,
        "planning_review" => copy.planning_review,
        "task_execution" | "execution" => copy.execution,
        "task_review" | "review" => copy.task_review,
        "validation" => copy.validation,
        _ if phase.starts_with("feedback_") => copy.feedback,
        "consolidation" => copy.consolidation,
        "reporting" => copy.reporting,
        _ => copy.working,
    }
}
