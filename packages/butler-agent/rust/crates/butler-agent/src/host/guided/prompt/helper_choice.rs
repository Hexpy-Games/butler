//! The line that tells a role which helper fits which kind of work.

use super::GuidedTextState;

const STEWARD_CHOICE: &str = "Choose the helper by the work. browse (the browsing agent) works inside pages toward one goal: it clicks, types, selects, navigates and pulls named fields with sources, on an efficient model with a compact per-step context, and runs beside your Workers. A Worker takes a bounded research or analysis piece: it reads across sources, compares and judges, uses non-browser tools and writes its Task output; it reads pages but does not operate them. When a piece needs both, split it: browse operates the page, and a Worker or you judge the result. Each browse step sends far less context than a Worker or Steward round and runs on the efficient model.";

const BUTLER_CHOICE: &str = "Choose the helper by the work. browse (the browsing agent) works inside pages toward one goal: it clicks, types, selects, navigates and pulls named fields with sources, on an efficient model with a compact per-step context. delegate_to_steward takes research, comparison or production that needs a plan; its Steward assigns Workers and the browsing agent. When a page step is part of a larger delegated job, leave it to the Steward. Each browse step sends far less context than your own round and runs on the efficient model.";

const WORKER_CHOICE: &str = "Choose the page reader by what you need. browse (the browsing agent) takes one page goal and the fields you need, works through the page on an efficient model with a compact per-step context, and returns only those fields with quoted evidence, a short summary and the tab; for you it opens and reads pages but does not operate them. browser_read brings the page text into your own context, which each of your later rounds sends again. Use browse to pull named facts from a page or from pages it links to, and browser_read when you must judge or quote a page's text yourself. Run independent browse calls in one round.";

/// The helper-choice line, only for rounds that offer `browse` (and, for Butler and Steward, the role's delegate tool).
pub(super) fn helper_choice(state: &GuidedTextState) -> Option<String> {
    let offers = |name: &str| state.phase.authorized_names.iter().any(|n| n == name);
    if !offers("browse") {
        return None;
    }
    match state.phase.execution_policy.role.as_str() {
        "steward" if offers("delegate_to_worker") => Some(STEWARD_CHOICE.into()),
        "butler" if offers("delegate_to_steward") => Some(BUTLER_CHOICE.into()),
        "worker" => Some(WORKER_CHOICE.into()),
        _ => None,
    }
}
