//! `management/AutomationRuns.tsx`: a schedule's latest runs.
mod copy;

use butler_ds::ui::blocks::activity_feed::ActivityFeedItem;
use butler_ds::ui::blocks::automation_run_list::AutomationRunList;
use butler_ds::ui::context::{Ds, Lang};
use chrono::{DateTime, Utc};
use gpui::{App, IntoElement, RenderOnce, SharedString, Window};

use super::types::AutomationRunSummary;
use crate::ui::i18n::Locale;
use copy::{Words, words};

/// `AutomationRuns`: the six newest runs, as the detail shows them.
#[derive(IntoElement)]
pub(crate) struct AutomationRuns {
    runs: Vec<AutomationRunSummary>,
}

impl AutomationRuns {
    pub(crate) fn new(runs: Vec<AutomationRunSummary>) -> Self {
        Self { runs }
    }
}

impl RenderOnce for AutomationRuns {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let lang = Ds::get(cx).lang();
        let words = words(lang);
        let items = self.runs.iter().take(6).map(|run| {
            ActivityFeedItem::new(SharedString::from(run.id.clone()), run_label(run, words))
                .meta(SharedString::from(relative_age(&run.started_at, lang)))
        });
        AutomationRunList::new("automation-runs", items.collect())
            .title(words.title)
            .empty_label(words.empty)
    }
}

/// `automationRunLabel`
fn run_label(run: &AutomationRunSummary, words: &Words) -> &'static str {
    match (run.safe_error_code.as_deref(), run.state.as_str()) {
        (Some("schedule_signin_off"), _) => words.signin_off,
        (Some("schedule_payment_off"), _) => words.payment_off,
        (Some("schedule_permission_required"), _) => words.needs_permission,
        (_, "queued") => words.queued,
        (_, "succeeded") => words.succeeded,
        (_, "failed") => words.failed,
        (_, "running") => words.running,
        (_, "skipped_target_unavailable") => words.skipped_target_unavailable,
        (_, "cancelled") => words.cancelled,
        _ => words.not_run,
    }
}

/// `relativeAge`: empty when the timestamp does not parse.
fn relative_age(at: &str, lang: Lang) -> String {
    let Ok(at) = DateTime::parse_from_rfc3339(at) else {
        return String::new();
    };
    let seconds = (Utc::now() - at.with_timezone(&Utc)).num_seconds().max(0);
    let locale = match lang {
        Lang::Ko => Locale::Ko,
        Lang::En => Locale::En,
    };
    locale.strings().relative_age(seconds)
}
