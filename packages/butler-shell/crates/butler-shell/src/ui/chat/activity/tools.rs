//! `ToolchainDisclosureRow`, `toolchainUtils/Details/Icons`, `ThinkingDetails`, `WorkerCallCapsule`.
pub(in crate::ui::chat::activity) mod copy;
mod labels;
mod thinking;
mod worker;

use butler_ds::tokens::Length;
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::disclosure_row::DisclosureRow;
use butler_ds::ui::blocks::list_row::ListRow;
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::icon_px;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::Typo;
use gpui::{
    AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Styled as _, Window, div,
    px,
};

use self::labels::{activity_icon, detail_text, nonempty, summary_label};
use super::operation::{Ids, output_details};
use crate::ui::chat::TranscriptCtx;
use crate::ui::decisions::browser_step_still;
use crate::ui::source::wire::ProgressRow;
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

/// The open state of a row; the body is built from the first open on, so a stored output is
/// read only once the row has been opened.
#[derive(Default)]
struct Disclosure {
    open: bool,
    seen: bool,
}

/// The operation a row's output belongs to.
fn operation_ids(row: &ProgressRow) -> Option<Ids> {
    Some(Ids {
        turn: nonempty(row.turn_id.as_deref())?.to_owned(),
        request: nonempty(row.tool_call_id.as_deref())?.to_owned(),
        result: nonempty(row.tool_result_id.as_deref())?.to_owned(),
    })
}

/// The details of a row: `workActivityToolsFromRows` for thinking rows, else
/// `toolDetails` (toolchainDetails.tsx).
fn details_of(row: &ProgressRow, thinking: bool, lang: Lang) -> Option<Details> {
    if thinking {
        let has_text = nonempty(row.thinking_body.as_deref()).is_some();
        let result = nonempty(row.tool_result_id.as_deref()).is_some();
        return (has_text || result).then(|| Details::Thinking(operation_ids(row)));
    }
    if let Some(ids) = operation_ids(row) {
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
        Details::Text(text) => Typo::caption(text).into_any_element(),
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

/// `workActivityToolsFromRows` / `workActivityToolsForBlock`: the tool rows of a step, in one
/// column under its heading. With `block_label`, rows the block does not show are left out
/// (`toolchainRowsForBlock`).
pub(super) fn tool_column(
    rows: &[ProgressRow],
    block_label: Option<&str>,
    content_x: f32,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let shown: Vec<&ProgressRow> = rows
        .iter()
        .filter(|row| block_label.is_none_or(|label| is_visible_tool_activity(row, label)))
        .filter(|row| is_work_activity_tool_row(row))
        .collect();
    if shown.is_empty() {
        return None;
    }
    // `toolchainAfter`: only the latest browser step shows its still.
    let latest = rows.iter().rev().find(|row| is_browser_step(row));
    let items: Vec<AnyElement> = shown
        .into_iter()
        .map(|row| {
            tool_row(
                row,
                latest.is_some_and(|l| std::ptr::eq(l, row)),
                t,
                window,
                cx,
            )
        })
        .collect();
    Some(
        div()
            .pl(px(content_x))
            .child(Stack::new().gap(Space::Xs).children(items))
            .into_any_element(),
    )
}

/// A `browser_act` row with a stored result.
pub(super) fn is_browser_step(row: &ProgressRow) -> bool {
    row.safe_tool_name.as_deref() == Some("browser_act")
        && nonempty(row.tool_result_id.as_deref()).is_some()
}

/// `BrowserStepStill` of a row's step.
fn row_still(row: &ProgressRow, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    let turn = nonempty(row.turn_id.as_deref())?;
    let call = nonempty(row.tool_call_id.as_deref())?;
    let result = nonempty(row.tool_result_id.as_deref())?;
    browser_step_still(turn, call, result, None, window, cx)
}

/// One tool/thinking/worker row of a turn's activity; `latest_browser` marks the row that
/// shows the step's still.
fn tool_row(
    row: &ProgressRow,
    latest_browser: bool,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let lang = Ds::get(cx).lang();
    let thinking = nonempty(row.thinking_title.as_deref());
    let title = thinking.map_or_else(|| summary_label(row, lang), str::to_owned);
    let icon = if thinking.is_some() {
        Icon::AiChip
    } else {
        activity_icon(row)
    };
    let glyph = icon_px(icon, Ds::get(cx).len(Length::IconSizeMd));
    let id = SharedString::from(format!("tool-row:{}", row.id));
    let head = match details_of(row, thinking.is_some(), lang) {
        None => ListRow::new(title).icon(glyph).into_any_element(),
        Some(details) => {
            let state = window.use_keyed_state(
                SharedString::from(format!("{id}:disclosure")),
                cx,
                |_, _| Disclosure::default(),
            );
            let (open, seen) = {
                let current = state.read(cx);
                (current.open, current.seen)
            };
            let toggle = state.clone();
            let mut disclosure = DisclosureRow::new(id, title)
                .icon(glyph)
                .reveals()
                .open(open)
                .on_toggle(move |_, _, cx| {
                    toggle.update(cx, |current, cx| {
                        current.open = !current.open;
                        current.seen = true;
                        cx.notify();
                    });
                });
            if open || seen {
                disclosure = disclosure.child(body(details, row, window, cx));
            }
            disclosure.into_any_element()
        }
    };
    let after = worker::capsule(row, t, lang)
        .or_else(|| latest_browser.then(|| row_still(row, window, cx)).flatten());
    match after {
        Some(after) => Stack::new()
            .gap(Space::Xs)
            .child(head)
            .child(after)
            .into_any_element(),
        None => head,
    }
}
