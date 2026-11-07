//! `CanonProposalChanges` and `CanonProposalFact`.
use butler_ds::ui::field::{Field, FieldTitle};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::blocks::markdown_content::{Density, MarkdownContent};
use butler_ds::ui::typo::{Tone, Typo, Wrap};
use gpui::{AnyElement, IntoElement as _, ParentElement as _, SharedString};

use crate::ui::i18n::canon_proposal::CanonProposalCopy;
use crate::ui::source::wire::CanonProposalChange;

/// `CanonProposalChanges`: only the actionable fields appear.
pub(super) fn changes_block(
    proposal_id: &str,
    changes: &[CanonProposalChange],
    copy: &CanonProposalCopy,
) -> Option<AnyElement> {
    let visible: Vec<(usize, &CanonProposalChange, &str)> = changes
        .iter()
        .enumerate()
        .filter_map(|(i, change)| change_label(&change.op, copy).map(|label| (i, change, label)))
        .collect();
    if visible.is_empty() {
        return None;
    }
    Some(
        Stack::new()
            .gap(Space::Lg)
            .children(visible.into_iter().map(|(i, change, label)| {
                change_block(&format!("{proposal_id}-change-{i}"), change, label, copy)
            }))
            .into_any_element(),
    )
}

fn change_label<'a>(op: &str, copy: &'a CanonProposalCopy) -> Option<&'a str> {
    Some(match op {
        "epic.delete" => copy.delete_epic,
        "epic.edit" => copy.edit_epic,
        "epic.move" => "",
        "plan.create" => copy.add_plan,
        "plan.edit" => copy.edit_plan,
        "plan.reorder" => copy.reorder,
        "spec.edit" => copy.edit_spec,
        _ => return None,
    })
}

fn change_block(
    key: &str,
    change: &CanonProposalChange,
    label: &str,
    copy: &CanonProposalCopy,
) -> AnyElement {
    let epic_op = change.op.starts_with("epic.");
    let mut block = Stack::new().gap(Space::Md);
    if change.op != "epic.move" {
        block = block.child(Typo::caption(label.to_owned()).tone(Tone::Secondary));
    }
    if (change.op == "epic.delete" || !epic_op)
        && let Some(title) = change.title.as_ref().filter(|title| !title.is_empty())
    {
        block = block.child(Typo::panel_title(title.clone()).wrap(Wrap::Anywhere));
    }
    if change.op == "epic.delete" {
        block = block.child(Typo::caption(copy.delete_detail));
    }
    let body = change.body.as_ref().or(change.description.as_ref());
    if !epic_op && let Some(body) = body.filter(|body| !body.is_empty()) {
        block = block.child(
            MarkdownContent::new(SharedString::from(format!("{key}-body")), body.clone())
                .density(Density::Compact),
        );
    }
    if let Some(facts) = change_facts(key, change, copy) {
        block = block.child(facts);
    }
    block.into_any_element()
}

/// The labelled values of one change; `None` when it has none.
fn change_facts(
    key: &str,
    change: &CanonProposalChange,
    copy: &CanonProposalCopy,
) -> Option<AnyElement> {
    let moved = change.op == "epic.move";
    if !(moved
        || change.status.is_some()
        || change.assignee.is_some()
        || change.due_on.is_some()
        || change.order_titles.is_some())
    {
        return None;
    }
    let mut facts: Vec<AnyElement> = Vec::new();
    let mut add = |name: &str, label: &str, value: String| {
        facts.push(fact(&format!("{key}-{name}"), label, value));
    };
    if moved {
        let backlog = || copy.backlog.to_owned();
        add(
            "current",
            copy.current_plan,
            change.current_plan_title.clone().unwrap_or_else(backlog),
        );
        add(
            "destination",
            copy.destination_plan,
            change.destination_plan_title.clone().unwrap_or_else(backlog),
        );
    }
    if let Some(status) = &change.status {
        add("status", copy.status, status_label(status, copy).to_owned());
    }
    if let Some(assignee) = &change.assignee {
        let value = match assignee.as_deref() {
            Some("app-user") => copy.me.to_owned(),
            Some(other) => other.to_owned(),
            None => copy.none.to_owned(),
        };
        add("assignee", copy.assignee, value);
    }
    if let Some(due_on) = &change.due_on {
        add("due", copy.due_on, due_on.clone().unwrap_or_else(|| copy.none.to_owned()));
    }
    if let Some(titles) = &change.order_titles {
        add("order", copy.order, titles.join(" → "));
    }
    Some(Stack::new().gap(Space::Lg).children(facts).into_any_element())
}

fn status_label<'a>(status: &str, copy: &'a CanonProposalCopy) -> &'a str {
    match status {
        "planned" => copy.planned,
        "in_progress" => copy.in_progress,
        "in_review" => copy.in_review,
        "blocked" => copy.blocked,
        "done" => copy.done,
        "cancelled" => copy.status_cancelled,
        "closed" => copy.closed,
        _ => copy.open,
    }
}

/// `CanonProposalFact`
pub(super) fn fact(key: &str, label: &str, value: String) -> AnyElement {
    Field::new(SharedString::from(key.to_owned()))
        .child(FieldTitle::new().child(SharedString::from(label.to_owned())))
        .child(Typo::body(value).wrap(Wrap::Anywhere))
        .into_any_element()
}
