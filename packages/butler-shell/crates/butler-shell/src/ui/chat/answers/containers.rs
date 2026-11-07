//! Answer blocks: columns, tabs, group.
use butler_ds::ui::blocks::block_columns::BlockColumns;
use butler_ds::ui::blocks::block_tabs::{BlockTab, BlockTabs};
use butler_ds::ui::layout::{Space, Stack};
use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement as _, ParentElement as _, SharedString,
    Window, div,
};

use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::{
    AnswerBlock, AnswerBlockCalloutTone, AnswerLeafBlock, AnswerLeafBlockCalloutTone,
};

/// Renders one block of this family (columns, tabs, group).
pub(super) fn render(
    block: &AnswerBlock,
    path: &str,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    match block {
        AnswerBlock::Columns { blocks, .. } => {
            let mut columns =
                BlockColumns::new(SharedString::from(format!("answer-columns-{path}")));
            for column in children(blocks, path, t, window, cx) {
                columns = columns.child(column);
            }
            columns.into_any_element()
        }
        AnswerBlock::Tabs { title, tabs, .. } => {
            let label = SharedString::from(title.clone().unwrap_or_default());
            let mut list = BlockTabs::new(SharedString::from(format!("answer-tabs-{path}")), label);
            for (index, tab) in tabs.iter().enumerate() {
                let tab_path = format!("{path}/tabs/{index}");
                let content = Stack::new().gap(Space::Md).children(children(
                    &tab.blocks,
                    &tab_path,
                    t,
                    window,
                    cx,
                ));
                list = list.tab(BlockTab::new(
                    SharedString::from(tab.label.clone()),
                    content,
                ));
            }
            list.into_any_element()
        }
        AnswerBlock::Group { blocks, .. } => Stack::new()
            .gap(Space::Md)
            .children(children(blocks, path, t, window, cx))
            .into_any_element(),
        _ => div().into_any_element(),
    }
}

/// `children`: each leaf in its own `Stack gap="sm"`, rendered through `render` (framed, child level).
fn children(
    leaves: &[AnswerLeafBlock],
    path: &str,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Vec<AnyElement> {
    leaves
        .iter()
        .enumerate()
        .filter_map(|(index, leaf)| {
            let block = leaf_block(leaf.clone()).ok()?;
            let leaf_path = format!("{path}/blocks/{index}");
            let rendered = super::child_block(&block, &leaf_path, t, window, cx);
            let cell = Stack::new().gap(Space::Sm).child(rendered);
            Some(
                div()
                    .id(SharedString::from(format!("answer-leaf-{leaf_path}")))
                    .child(cell)
                    .into_any_element(),
            )
        })
        .collect()
}

/// A leaf block as the block the family renders take (every leaf variant is one of the two groups).
pub(super) fn leaf_block(leaf: AnswerLeafBlock) -> Result<AnswerBlock, Box<AnswerLeafBlock>> {
    data_leaf(leaf).or_else(|other| text_leaf(*other))
}

/// The data-like leaves (cards, table, gallery, facts, metrics, chart, callout, actions).
fn data_leaf(leaf: AnswerLeafBlock) -> Result<AnswerBlock, Box<AnswerLeafBlock>> {
    use AnswerLeafBlock as L;
    Ok(match leaf {
        L::Cards {
            id,
            title,
            media,
            items,
        } => AnswerBlock::Cards {
            id,
            title,
            media,
            items,
        },
        L::Table {
            id,
            title,
            columns,
            rows,
        } => AnswerBlock::Table {
            id,
            title,
            columns,
            rows,
        },
        L::Gallery {
            id,
            title,
            media,
            items,
        } => AnswerBlock::Gallery {
            id,
            title,
            media,
            items,
        },
        L::Facts { id, title, items } => AnswerBlock::Facts { id, title, items },
        L::Metrics { id, title, items } => AnswerBlock::Metrics { id, title, items },
        L::Chart {
            id,
            title,
            kind,
            x,
            series,
            unit,
            checked,
            source,
        } => AnswerBlock::Chart {
            id,
            title,
            kind,
            x,
            series,
            unit,
            checked,
            source,
        },
        L::Callout {
            id,
            title,
            tone,
            text,
        } => AnswerBlock::Callout {
            id,
            title,
            tone: tone.map(callout_tone),
            text,
        },
        L::Actions { id, title, items } => AnswerBlock::Actions { id, title, items },
        other => return Err(Box::new(other)),
    })
}

/// The text-like leaves (timeline, checklist, progress, text, image, quote).
fn text_leaf(leaf: AnswerLeafBlock) -> Result<AnswerBlock, Box<AnswerLeafBlock>> {
    use AnswerLeafBlock as L;
    Ok(match leaf {
        L::Timeline { id, title, items } => AnswerBlock::Timeline { id, title, items },
        L::Checklist { id, title, items } => AnswerBlock::Checklist { id, title, items },
        L::Progress { id, title, items } => AnswerBlock::Progress { id, title, items },
        L::Text { id, title, text } => AnswerBlock::Text { id, title, text },
        L::Image {
            id,
            title,
            img,
            caption,
            source,
        } => AnswerBlock::Image {
            id,
            title,
            img,
            caption,
            source,
        },
        L::Quote {
            id,
            title,
            text,
            cite,
            source,
        } => AnswerBlock::Quote {
            id,
            title,
            text,
            cite,
            source,
        },
        other => return Err(Box::new(other)),
    })
}

fn callout_tone(tone: AnswerLeafBlockCalloutTone) -> AnswerBlockCalloutTone {
    match tone {
        AnswerLeafBlockCalloutTone::Neutral => AnswerBlockCalloutTone::Neutral,
        AnswerLeafBlockCalloutTone::Info => AnswerBlockCalloutTone::Info,
        AnswerLeafBlockCalloutTone::Success => AnswerBlockCalloutTone::Success,
        AnswerLeafBlockCalloutTone::Warning => AnswerBlockCalloutTone::Warning,
        AnswerLeafBlockCalloutTone::Unknown => AnswerBlockCalloutTone::Unknown,
    }
}
