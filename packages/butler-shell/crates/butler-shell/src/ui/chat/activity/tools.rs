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
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window};

use self::labels::{activity_icon, detail_text, nonempty, summary_label};
use super::operation::{Ids, output_details};
use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::ProgressRow;

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

fn body(
    details: Details,
    row: &ProgressRow,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    match details {
        Details::Output(ids) => {
            let command = (row.safe_tool_name.as_deref() == Some("run_command"))
                .then_some(row.safe_input_label.as_deref())
                .flatten();
            output_details(&ids, row.safe_tool_name.as_deref(), command, t, window, cx)
        }
        Details::Thinking(ids) => thinking::thinking_details(row, ids, t, window, cx),
        Details::Text(text) => Typo::caption(text).into_any_element(),
    }
}

/// One tool/thinking/worker row of a turn's activity.
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(crate) fn tool_row(
    row: &ProgressRow,
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
                disclosure = disclosure.child(body(details, row, t, window, cx));
            }
            disclosure.into_any_element()
        }
    };
    match worker::capsule(row, t, lang) {
        Some(after) => Stack::new()
            .gap(Space::Xs)
            .child(head)
            .child(after)
            .into_any_element(),
        None => head,
    }
}
