//! The task document dialog: the part of `ProjectDocumentDialog` a task document uses (its
//! title, kind and markdown body).
use butler_ds::ui::blocks::markdown_content::MarkdownContent;
use butler_ds::ui::dialog::{
    Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Layout, Size,
};
use gpui::{AnyElement, App, Entity, ParentElement as _, Window};

use crate::ui::i18n::task_graph::Words;
use crate::ui::source::wire::TaskGraphDocumentWire;

/// `projectDocumentMarkdownView(...).body`: the markdown without its frontmatter.
fn without_frontmatter(markdown: &str) -> &str {
    let Some(rest) = markdown
        .strip_prefix("---\r\n")
        .or_else(|| markdown.strip_prefix("---\n"))
    else {
        return markdown;
    };
    let Some(end) = rest.find("\n---") else {
        return markdown;
    };
    let after = &rest[end + "\n---".len()..];
    let after = after
        .strip_prefix("\r\n")
        .or_else(|| after.strip_prefix('\n'))
        .unwrap_or(after);
    after.trim_start()
}

/// `projectDocumentReaderView(...).body` of a task export: its section headings are localized.
fn body(document: &TaskGraphDocumentWire, words: &Words) -> String {
    let text = without_frontmatter(&document.markdown);
    if document.source_label != "Task document" {
        return text.to_owned();
    }
    text.split('\n')
        .map(|line| match line.trim_end_matches('\r') {
            "## Goal" => format!("## {}", words.goal),
            "## Done criteria" => format!("## {}", words.criteria),
            "## Predecessors" => format!("## {}", words.predecessors),
            _ => line.to_owned(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `ProjectDocumentDialog`: open while a document is set; closing clears it.
pub(super) fn document_dialog(
    document: &Entity<Option<TaskGraphDocumentWire>>,
    words: &Words,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let current = document.read(cx).clone();
    let dialog = {
        let document = document.clone();
        Dialog::new("task-document-dialog", window, cx)
            .open(current.is_some())
            .on_open_change(move |open, _, cx| {
                if !open {
                    document.update(cx, |document, cx| {
                        *document = None;
                        cx.notify();
                    });
                }
            })
    };
    let content = match &current {
        Some(document) => DialogContent::new()
            .size(Size::Xl)
            .layout(Layout::ScrollBody)
            .header(
                DialogHeader::new()
                    .child(DialogDescription::new(words.document))
                    .child(DialogTitle::new(document.title.clone())),
            )
            .child(MarkdownContent::new(
                "task-document-body",
                body(document, words),
            )),
        None => DialogContent::new(),
    };
    dialog.content(content, window, cx)
}
