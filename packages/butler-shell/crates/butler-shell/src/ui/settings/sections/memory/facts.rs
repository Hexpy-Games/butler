//! `MemoryFacts.tsx`: the measured facts of a memory card or a project, as a meta list.
use butler_ds::ui::context::Lang;
use butler_ds::ui::meta_list::{MetaItem, MetaList};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, IntoElement as _};

use super::copy::Words;
use super::format::{ago, count, file_size, relative_age};
use super::types::{Card, ProjectInfo};

/// Index into [`Words::facts`].
const INSTRUCTIONS: usize = 0;
const CHATS: usize = 1;
const ENTRIES: usize = 2;
const CANDIDATES: usize = 3;
const SIZE: usize = 4;
const UPDATED: usize = 5;
const CAN_FREE: usize = 6;
const SUMMARY: usize = 7;

fn not_measured(copy: &Words) -> AnyElement {
    Typo::caption(copy.not_measured)
        .tone(Tone::Tertiary)
        .into_any_element()
}

pub(super) fn memory_facts(
    card: Option<&Card>,
    project: Option<&ProjectInfo>,
    copy: &Words,
    lang: Lang,
) -> AnyElement {
    if let Some(card) = card
        && card.item_count.is_none()
        && card.allocated_bytes.is_none()
        && card.pending_count.is_none()
    {
        return not_measured(copy);
    }
    let mut items: Vec<MetaItem> = Vec::new();
    let mut add = |label: &str, value: Option<String>| {
        if let Some(value) = value {
            items.push(MetaItem::new(label.to_owned(), value));
        }
    };
    if let Some(project) = project {
        let summary = project
            .summary_bytes
            .map_or_else(|| copy.none.to_owned(), file_size);
        add(copy.facts[SUMMARY], Some(summary));
        add(copy.facts[CHATS], project.conversations.map(count));
        add(copy.facts[INSTRUCTIONS], project.instructions.map(count));
    } else if let Some(card) = card {
        let label = match card.kind.as_str() {
            "pinned" => INSTRUCTIONS,
            "profile" => ENTRIES,
            _ => CHATS,
        };
        add(copy.facts[label], card.item_count.map(count));
        if card.kind == "profile" {
            add(copy.facts[CANDIDATES], card.pending_count.map(count));
        }
        if card.kind != "pinned" {
            add(copy.facts[SIZE], card.allocated_bytes.map(file_size));
        }
    }
    let updated = project
        .and_then(|project| project.updated_at.as_deref())
        .or(card.and_then(|card| card.content_updated_at.as_deref()));
    if let Some(updated) = updated {
        add(
            copy.facts[UPDATED],
            Some(ago(&relative_age(updated, lang), lang)),
        );
    }
    if let Some(card) = card
        && card.kind == "automatic"
    {
        add(
            copy.facts[CAN_FREE],
            card.health.reclaimable_bytes.map(file_size),
        );
    }
    if items.is_empty() {
        not_measured(copy)
    } else {
        MetaList::new(items).into_any_element()
    }
}
