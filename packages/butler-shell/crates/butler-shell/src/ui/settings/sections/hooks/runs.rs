//! `HookRuns.tsx` and `developerLogFormat.ts` `formatTimestamp`.
use std::rc::Rc;

use butler_ds::ui::blocks::card_list::CardList;
use butler_ds::ui::blocks::disclosure_row::DisclosureRow;
use gpui::{App, ParentElement as _, SharedString, Window};

use super::copy::HooksCopy;
use super::types::HookRun;
use crate::ui::settings::controls::raw_block;

/// The date and time in the owner's time zone; text that is not a time stays as it is.
fn format_timestamp(value: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(value) {
        Ok(time) => time
            .with_timezone(&chrono::Local)
            .format("%m/%d %H:%M:%S")
            .to_string(),
        Err(_) => value.to_owned(),
    }
}

/// Opens or closes the run row at an index.
pub(super) type OnToggle = Rc<dyn Fn(usize, &mut Window, &mut App)>;

/// The runs, newest first; one row is open at a time.
pub(super) fn runs_list(
    runs: &[HookRun],
    expanded: Option<usize>,
    copy: &HooksCopy,
    on_toggle: &OnToggle,
) -> CardList {
    let rows = runs.iter().rev().enumerate().map(|(index, run)| {
        let outcome = match run.outcome.as_str() {
            "continue" => copy.test_success,
            "deny" => copy.blocked,
            _ => copy.test_failure,
        };
        let title = [run.hook_id.as_str(), run.event.as_str(), outcome].join(" · ");
        let exit = run
            .exit_code
            .map(|code| format!("{} {code}", copy.exit_code));
        let description = [
            Some(format_timestamp(&run.time)),
            run.session_id.clone(),
            Some(format!("{} ms", run.duration_ms)),
            exit,
        ]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
        let detail = [
            run.reason.as_deref().unwrap_or_default(),
            run.stdout.as_str(),
            run.stderr.as_str(),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
        let toggle = on_toggle.clone();
        DisclosureRow::new(SharedString::from(format!("hook-run-{index}")), title)
            .description(description)
            .open(expanded == Some(index))
            .on_toggle(move |_, window, cx| toggle(index, window, cx))
            .child(raw_block(
                SharedString::from(format!("hook-run-raw-{index}")),
                run.hook_id.clone(),
                detail,
                false,
                true,
            ))
    });
    CardList::new("hook-runs-list").flush().children(rows)
}
