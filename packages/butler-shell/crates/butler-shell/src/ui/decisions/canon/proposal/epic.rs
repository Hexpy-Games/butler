//! The Epic part of `CanonProposalCard`: title, description and tags.
use butler_ds::ui::blocks::markdown_content::{Density, MarkdownContent};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::tag::{LabelTone, Size as TagSize, Tag, Tone as TagTone};
use butler_ds::ui::typo::{Typo, Wrap};
use gpui::{AnyElement, IntoElement as _, ParentElement as _, SharedString};

use crate::ui::source::wire::CanonProposalEpic;

/// One proposed Epic: title, description without attachment links, tags.
pub(super) fn epic_block(proposal_id: &str, index: usize, epic: &CanonProposalEpic) -> AnyElement {
    let description = strip_attachment_links(&epic.description);
    let mut block = Stack::new()
        .gap(Space::Sm)
        .child(Typo::panel_title(epic.title.clone()).wrap(Wrap::Anywhere));
    if !description.trim().is_empty() {
        block = block.child(
            MarkdownContent::new(
                SharedString::from(format!("canon-proposal-{proposal_id}-epic-{index}")),
                description,
            )
            .density(Density::Compact),
        );
    }
    if !epic.tags.is_empty() {
        block = block.child(Stack::row().gap(Space::Xs).wrap(true).children(
            epic.tags.iter().enumerate().map(|(i, tag)| {
                Tag::new(
                    SharedString::from(format!("canon-proposal-{proposal_id}-{index}-tag-{i}")),
                    tag.name.clone(),
                )
                .tone(TagTone::Label(label_tone(&tag.color)))
                .size(TagSize::Sm)
            }),
        ));
    }
    block.into_any_element()
}

fn label_tone(color: &str) -> LabelTone {
    match color {
        "red" => LabelTone::Red,
        "orange" => LabelTone::Orange,
        "yellow" => LabelTone::Yellow,
        "green" => LabelTone::Green,
        "teal" => LabelTone::Teal,
        "blue" => LabelTone::Blue,
        "purple" => LabelTone::Purple,
        _ => LabelTone::Gray,
    }
}

/// `description.replace(/!?\[[^\]]*\]\(attachment:[^)]+\)/giu, "")`
fn strip_attachment_links(text: &str) -> String {
    let (mut out, mut rest) = (String::new(), text);
    while let Some(start) = rest.find('[') {
        let from = if rest[..start].ends_with('!') {
            start - 1
        } else {
            start
        };
        if let Some(len) = attachment_link_len(&rest[start..]) {
            out.push_str(&rest[..from]);
            rest = &rest[start + len..];
        } else {
            out.push_str(&rest[..=start]);
            rest = &rest[start + 1..];
        }
    }
    out.push_str(rest);
    out
}

/// The length of `[label](attachment:target)` at the start of `text`.
fn attachment_link_len(text: &str) -> Option<usize> {
    let close = text.find(']')?;
    let after = &text[close + 1..];
    let scheme = after.get(..12)?;
    if !scheme.starts_with('(') || !scheme[1..].eq_ignore_ascii_case("attachment:") {
        return None;
    }
    let end = after[12..].find(')').filter(|end| *end > 0)?;
    Some(close + 1 + 12 + end + 1)
}
