//! `WorkBlocks`, `WorkBlockDetails`, `workBlock*`.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::work_activity::WorkActivityBlock;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::icon_px;
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::rolling_swap::RollingSwap;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window, px};

use super::tools::tool_column;
use crate::ui::chat::TranscriptCtx;
use crate::ui::i18n::Locale;
use crate::ui::source::wire::WorkBlockView;

pub(super) fn locale_of(lang: Lang) -> Locale {
    match lang {
        Lang::Ko => Locale::Ko,
        Lang::En => Locale::En,
    }
}

pub(super) fn locale(cx: &App) -> Locale {
    locale_of(Ds::get(cx).lang())
}

/// Where the content column of a block starts, which its tool rows line up with.
// DS: WorkActivityBlock geometry (`content_x`)
pub(super) fn content_x(compact: bool) -> f32 {
    if compact { 28. } else { 44. }
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

/// `ActivityBlock` of WorkBlocks.tsx without its toolchain.
fn block_header(block: &WorkBlockView) -> WorkActivityBlock {
    let running = !matches!(block.state.as_str(), "delivered" | "failed" | "cancelled");
    let mut view = WorkActivityBlock::new(format!("work-block-{}", block.id), block.label.clone());
    if running {
        view = view.live();
    }
    if let Some(body) = decision_body(block) {
        view = view.description(body);
    }
    view
}

/// `workActivityToolsForBlock`: the block's tool rows.
fn block_tools(
    block: &WorkBlockView,
    turn: Option<&str>,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    tool_column(
        &block.rows,
        Some(&block.label),
        turn,
        content_x(false),
        t,
        window,
        cx,
    )
}

fn block_view(
    block: &WorkBlockView,
    turn: Option<&str>,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let tools = block_tools(block, turn, t, window, cx);
    Stack::new()
        .gap(Space::Sm)
        .child(block_header(block))
        .children(tools)
        .into_any_element()
}

fn toggle_state(id: &str, window: &mut Window, cx: &mut App) -> gpui::Entity<bool> {
    window.use_keyed_state(format!("{id}-expanded"), cx, |_, _| false)
}

/// The expanded history's collapse control (`CollapsedTurnActivity`).
fn collapse_button(key: &str, state: &gpui::Entity<bool>, label: &'static str) -> Stack {
    let state = state.clone();
    Stack::new().cross(Cross::Start).child(
        Button::new(format!("{key}-collapse"))
            .variant(Variant::Borderless)
            .size(Size::Xs)
            .icon_start(icon_px(Icon::ListChecks, px(14.)))
            .text(label)
            .on_click(move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| {
                state.update(cx, |open, cx| {
                    *open = false;
                    cx.notify();
                });
            }),
    )
}

/// `CollapsedTurnActivity` / `CompletedWorkBlocks`: the header, the latest block while live,
/// every block when expanded; `None` without blocks.
pub(crate) fn work_blocks(
    blocks: &[WorkBlockView],
    live: bool,
    turn: Option<&str>,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let latest = blocks.last()?.clone();
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
    let chevron = if expanded {
        Icon::ChevronDown
    } else {
        Icon::ChevronRight
    };
    let header = Stack::new().cross(Cross::Start).child(
        Button::new(format!("{key}-toggle"))
            .variant(Variant::Inline)
            .text(header_label)
            .icon_end(icon_px(chevron, px(14.)))
            .on_click(flip),
    );
    let mut body = Stack::new().gap(Space::Md);
    if expanded {
        let views: Vec<AnyElement> = blocks
            .iter()
            .map(|block| block_view(block, turn, t, window, cx))
            .collect();
        body = body.children(views);
        body = body.child(collapse_button(&key, &state, strings.activity_collapse()));
    } else if live {
        let item_key: SharedString = latest.id.clone().into();
        let tools = block_tools(&latest, turn, t, window, cx);
        let swapped = latest;
        body = body
            .child(RollingSwap::new(
                format!("{key}-swap"),
                item_key,
                move |_, _| block_header(&swapped).into_any_element(),
            ))
            .children(tools);
    }
    Some(
        Stack::new()
            .gap(Space::Md)
            .child(header)
            .child(body)
            .into_any_element(),
    )
}
