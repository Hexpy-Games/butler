//! `WorkBlocks`, `WorkBlockDetails`, `workBlock*`.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::work_activity::{ToolItem, WorkActivityBlock};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::icon_px;
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::rolling_swap::RollingSwap;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window, div, px};

use crate::ui::chat::TranscriptCtx;
use crate::ui::i18n::Locale;
use crate::ui::source::wire::{ProgressRow, WorkBlockView};

const TOOL_KINDS: [&str; 6] = ["searched", "read", "ran_command", "edited", "dispatch", "used_tool"];

pub(super) fn locale(cx: &App) -> Locale {
    match Ds::get(cx).lang() {
        Lang::Ko => Locale::Ko,
        Lang::En => Locale::En,
    }
}

/// `isWorkActivityToolRow`: a row that names a tool call, an input, details or a tool kind.
fn is_tool_row(row: &ProgressRow) -> bool {
    row.thinking_title.is_some()
        || row.tool_call_id.is_some()
        || row.safe_input_label.is_some()
        || row.safe_detail_rows.as_ref().is_some_and(|d| !d.is_empty())
        || row.kind.as_deref().is_some_and(|k| TOOL_KINDS.contains(&k))
}

/// `workActivityToolsFromRows`: one tool item per tool row.
pub(super) fn tool_items(rows: &[ProgressRow], lang: Lang) -> Vec<ToolItem> {
    rows.iter()
        .filter(|row| is_tool_row(row))
        .enumerate()
        .map(|(index, row)| match &row.thinking_title {
            Some(title) => {
                let summary = if lang == Lang::Ko { "생각" } else { "Thinking" };
                let item = ToolItem::new(
                    format!("thinking:{}", row.tool_call_id.as_deref().unwrap_or(&row.id)),
                    title.clone(),
                    summary,
                );
                match row.thinking_body.as_deref().filter(|b| !b.is_empty()) {
                    Some(body) => item.details(body.to_string()),
                    None => item,
                }
            }
            None => {
                let name = row.safe_tool_name.clone().unwrap_or_default();
                let title = if row.safe_label.is_empty() { name.clone() } else { row.safe_label.clone() };
                ToolItem::new(format!("{}:{index}", row.id), title, name)
            }
        })
        .collect()
}

/// `WorkDecisionBody`: the block's rationale and next step, one per line.
fn decision_body(block: &WorkBlockView) -> Option<String> {
    let lines: Vec<&str> = [&block.decision_rationale, &block.decision_next_step]
        .into_iter()
        .filter_map(|line| line.as_deref())
        .filter(|line| !line.trim().is_empty())
        .collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

/// `ActivityBlock` of WorkBlocks.tsx.
fn block_view(block: &WorkBlockView, lang: Lang) -> AnyElement {
    let running = !matches!(block.state.as_str(), "delivered" | "failed" | "cancelled");
    let mut view = WorkActivityBlock::new(format!("work-block-{}", block.id), block.label.clone())
        .tools(tool_items(&block.rows, lang));
    if running {
        view = view.live();
    }
    if let Some(body) = decision_body(block) {
        view = view.description(body);
    }
    view.into_any_element()
}

fn toggle_state(id: &str, window: &mut Window, cx: &mut App) -> gpui::Entity<bool> {
    window.use_keyed_state(format!("{id}-expanded"), cx, |_, _| false)
}

/// `CollapsedTurnActivity`: the header, the latest block while live, every block when expanded.
pub(super) fn collapsed_turn_activity(
    blocks: &[WorkBlockView],
    live: bool,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let latest = blocks.last()?.clone();
    let lang = Ds::get(cx).lang();
    let key = format!("work-blocks-{}", blocks[0].id);
    let state = toggle_state(&key, window, cx);
    let expanded = *state.read(cx);
    let strings = locale(cx).strings();
    let header_label = strings.activity_history(live, &latest.label, blocks.len());
    let flip = {
        let state = state.clone();
        move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| {
            state.update(cx, |open, cx| {
                *open = !*open;
                cx.notify();
            });
        }
    };
    let chevron = if expanded { Icon::ChevronDown } else { Icon::ChevronRight };
    let header = Stack::new().cross(Cross::Start).child(
        Button::new(format!("{key}-toggle"))
            .variant(Variant::Inline)
            .text(header_label)
            .icon_end(icon_px(chevron, px(14.)))
            .on_click(flip),
    );
    let mut body = Stack::new().gap(Space::Md);
    if expanded {
        body = body.children(blocks.iter().map(|block| block_view(block, lang)));
        let collapse = {
            let state = state.clone();
            move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| {
                state.update(cx, |open, cx| {
                    *open = false;
                    cx.notify();
                });
            }
        };
        let collapse_label = if lang == Lang::Ko { "접기" } else { "Collapse" };
        body = body.child(
            Stack::new().cross(Cross::Start).child(
                Button::new(format!("{key}-collapse"))
                    .variant(Variant::Borderless)
                    .size(Size::Xs)
                    .icon_start(icon_px(Icon::ListChecks, px(14.)))
                    .text(collapse_label)
                    .on_click(collapse),
            ),
        );
    } else if live {
        let item_key: SharedString = latest.id.clone().into();
        body = body.child(RollingSwap::new(format!("{key}-swap"), item_key, move |_, cx| {
            block_view(&latest, Ds::get(cx).lang())
        }));
    }
    Some(Stack::new().gap(Space::Md).child(header).child(body).into_any_element())
}

/// Completed work blocks (`CompletedWorkBlocks`).
pub(crate) fn work_blocks(
    blocks: &[WorkBlockView],
    _t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    collapsed_turn_activity(blocks, false, window, cx).unwrap_or_else(|| div().into_any_element())
}
