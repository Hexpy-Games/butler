//! `ToolchainDisclosureRow`, `toolchainUtils/Details/Icons`, `ThinkingDetails`, `WorkerCallCapsule`.
pub(in crate::ui::chat::activity) mod copy;
mod labels;
mod thinking;
pub(super) mod worker;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::work_activity::ToolItem;
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::selectable::Break;
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, Window};

pub(crate) use self::labels::tool_label;
use self::labels::{activity_icon, detail_text, group_label, nonempty, summary_label};
use super::operation::{Ids, output_details};
use crate::ui::decisions::browser_step_still;
use crate::ui::images::{self, ImageToolRow};
use crate::ui::source::wire::{ProgressRow, SessionView};
use crate::ui::store::progress::terminal::is_visible_tool_activity;

/// What a row reveals when it opens.
enum Details {
    /// The stored output of the tool call (`OperationOutputDetails`).
    Output(Ids),
    /// The reasoning summary of a thinking row (`ThinkingDetails`).
    Thinking(Option<Ids>),
    /// The tool's detail rows, joined.
    Text(String),
}

/// Electron `toolchainDetails.tsx`: the operation a row's output belongs to.
fn operation_ids(row: &ProgressRow, turn: Option<&str>) -> Option<Ids> {
    Some(Ids {
        turn: turn.or(nonempty(row.turn_id.as_deref()))?.to_owned(),
        request: nonempty(row.tool_call_id.as_deref())?.to_owned(),
        result: nonempty(row.tool_result_id.as_deref())?.to_owned(),
    })
}

/// The details of a row: `workActivityToolsFromRows` for thinking rows, else
/// `toolDetails` (toolchainDetails.tsx).
fn details_of(
    row: &ProgressRow,
    turn: Option<&str>,
    thinking: bool,
    lang: Lang,
) -> Option<Details> {
    if thinking {
        let has_text = nonempty(row.thinking_body.as_deref()).is_some();
        let result = nonempty(row.tool_result_id.as_deref()).is_some();
        return (has_text || result).then(|| Details::Thinking(operation_ids(row, turn)));
    }
    if let Some(ids) = operation_ids(row, turn) {
        return Some(Details::Output(ids));
    }
    let command = nonempty(row.safe_input_label.as_deref());
    let text = match (row.safe_tool_name.as_deref(), command) {
        (Some("run_command"), Some(command)) => {
            format!("{}: {command}", copy::text(lang, "st.execution"))
        }
        _ => detail_text(row, lang),
    };
    (!text.is_empty()).then_some(Details::Text(text))
}

fn body(details: Details, row: &ProgressRow, window: &mut Window, cx: &mut App) -> AnyElement {
    match details {
        Details::Output(ids) => {
            let command = (row.safe_tool_name.as_deref() == Some("run_command"))
                .then_some(row.safe_input_label.as_deref())
                .flatten();
            output_details(&ids, row.safe_tool_name.as_deref(), command, window, cx)
        }
        Details::Thinking(ids) => thinking::thinking_details(row, ids, window, cx),
        Details::Text(text) => Typo::caption(text)
            .selectable(Break::Line)
            .into_any_element(),
    }
}

const BOOKKEEPING_KINDS: [&str; 5] = ["work", "work_block", "plan", "checkpoint", "disposition"];
const BOOKKEEPING_TOOLS: [&str; 10] = [
    "start_work",
    "continue_work",
    "replace_work_plan",
    "record_work_checkpoint",
    "record_work_review",
    "record_work_disposition",
    "plan_review",
    "completion_review",
    "work_tool",
    "tool_work",
];

/// `isWorkActivityToolRow`: a row the timeline lists as a tool (work bookkeeping stays out).
fn is_work_activity_tool_row(row: &ProgressRow) -> bool {
    let kind = row.kind.as_deref().unwrap_or("").to_lowercase();
    !(BOOKKEEPING_KINDS.contains(&kind.as_str())
        || row
            .safe_tool_name
            .as_deref()
            .is_some_and(|name| BOOKKEEPING_TOOLS.contains(&name)))
}

/// `workActivityToolsFromRows` / `workActivityToolsForBlock`: the tool rows of a step as the
/// items its `WorkActivityBlock` lists. With `block_label`, rows the block does not show are left
/// out (`toolchainRowsForBlock`).
pub(super) fn tool_items(
    rows: &[ProgressRow],
    block_label: Option<&str>,
    turn: Option<&str>,
    view: &SessionView,
    window: &mut Window,
    cx: &mut App,
) -> Vec<ToolItem> {
    // `toolchainAfter`: only the latest browser step shows its still.
    let latest = rows.iter().rev().find(|row| is_browser_step(row));
    rows.iter()
        .filter(|row| block_label.is_none_or(|label| is_visible_tool_activity(row, label)))
        .filter(|row| is_work_activity_tool_row(row))
        .map(|row| {
            let latest_browser = latest.is_some_and(|l| std::ptr::eq(l, row));
            tool_item(row, turn, latest_browser, view, window, cx)
        })
        .collect()
}

/// A `browser_act` row with a stored result.
pub(super) fn is_browser_step(row: &ProgressRow) -> bool {
    row.safe_tool_name.as_deref() == Some("browser_act")
        && nonempty(row.tool_result_id.as_deref()).is_some()
}

/// `BrowserStepStill` of a row's step.
fn row_still(
    row: &ProgressRow,
    turn: Option<&str>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let turn = turn.or(nonempty(row.turn_id.as_deref()))?;
    let call = nonempty(row.tool_call_id.as_deref())?;
    let result = nonempty(row.tool_result_id.as_deref())?;
    browser_step_still(turn, call, result, None, window, cx)
}

/// Electron `toolchainAfter.tsx`: image tools with stored results show their output tiles.
fn image_still(
    row: &ProgressRow,
    turn: Option<&str>,
    session: &str,
    cx: &mut App,
) -> Option<AnyElement> {
    let tool = row.safe_tool_name.as_deref()?;
    if !matches!(tool, "generate_image" | "edit_image") {
        return None;
    }
    let turn = turn.or(nonempty(row.turn_id.as_deref()))?;
    let image_row = ImageToolRow {
        call_id: nonempty(row.tool_call_id.as_deref())?.to_owned().into(),
        result_id: nonempty(row.tool_result_id.as_deref())?.to_owned().into(),
        tool: tool.to_owned().into(),
        failed: false,
    };
    images::image_tool_still(turn, image_row, session, cx)
}

/// One tool/thinking/worker row of a turn's activity; `latest_browser` marks the row that
/// shows the step's still.
fn tool_item(
    row: &ProgressRow,
    turn: Option<&str>,
    latest_browser: bool,
    view: &SessionView,
    window: &mut Window,
    cx: &mut App,
) -> ToolItem {
    let lang = Ds::get(cx).lang();
    let thinking = nonempty(row.thinking_title.as_deref());
    let title = thinking.map_or_else(|| summary_label(row, lang), str::to_owned);
    let group = thinking.map_or_else(
        || group_label(row, lang),
        |_| copy::text(lang, "st.thinking").to_owned(),
    );
    let icon = if thinking.is_some() {
        Icon::AiChip
    } else {
        activity_icon(row)
    };
    let mut item = ToolItem::new(format!("tool-row:{}", row.id), title, group).icon(icon);
    if let Some(details) = details_of(row, turn, thinking.is_some(), lang) {
        let row = row.clone();
        item = item.details_with(move |window, cx| body(details, &row, window, cx));
    }
    let after = worker::capsule(row, turn, view)
        .or_else(|| image_still(row, turn, &view.session_id, cx))
        .or_else(|| {
            latest_browser
                .then(|| row_still(row, turn, window, cx))
                .flatten()
        });
    match after {
        Some(after) => item.after(after),
        None => item,
    }
}
