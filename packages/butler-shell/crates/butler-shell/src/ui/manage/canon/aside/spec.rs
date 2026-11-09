//! `SpecTree.tsx` and `CriterionRow.tsx`: the epic's specs as a tree of concerns, parts and
//! criteria, each criterion checked by a POST at its node's revision.
use butler_ds::ui::blocks::disclosure_row::{DisclosureRow, Surface};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::{IconButton, Tone as ButtonTone};
use butler_ds::ui::layout::{Box as Pad, Cross, Justify, Space, Stack};
use butler_ds::ui::rolling_swap::RollingSwap;
use butler_ds::ui::section::Section;
use butler_ds::ui::success_check::SuccessCheck;
use butler_ds::ui::typo::{Tone, Typo, Weight, Wrap};
use butler_shell_client::Error;
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _, SharedString};
use serde::Deserialize;
use serde_json::json;

use super::inspector::EpicInspector;
use crate::ui::Icon;
use crate::ui::manage::canon::common;
use crate::ui::source::fetch::fetch;
use crate::ui::source::wire::{CriteriaCount, SpecCriterion, SpecNode};

/// The answer carries nothing the tree reads: the epic is read again.
#[derive(Deserialize)]
struct Checked {}

/// One tree level: children start one `md` step right of their parent's title.
fn level(children: Vec<AnyElement>) -> AnyElement {
    Pad::new()
        .padding_start(Space::Md)
        .child(Stack::new().gap(Space::Sm).children(children))
        .into_any_element()
}

/// The criteria of a node by `part_id`, in the order the parts first appear.
fn parts(node: &SpecNode) -> Vec<(&str, Vec<&SpecCriterion>)> {
    let mut groups: Vec<(&str, Vec<&SpecCriterion>)> = Vec::new();
    for criterion in &node.criteria {
        match groups
            .iter_mut()
            .find(|(part, _)| *part == criterion.part_id)
        {
            Some((_, group)) => group.push(criterion),
            None => groups.push((&criterion.part_id, vec![criterion])),
        }
    }
    groups
}

impl EpicInspector {
    /// `SpecTree`
    pub(super) fn spec_tree(
        &self,
        nodes: &[SpecNode],
        criteria: Option<&CriteriaCount>,
        compact: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = Self::words(cx);
        let mut section = Section::new("canon-spec-tree").gap(Space::Sm);
        if criteria.is_none() {
            section = if compact {
                section.title_element(
                    Typo::caption(words.specs)
                        .tone(Tone::Secondary)
                        .weight(Weight::Medium),
                )
            } else {
                section.title(words.specs)
            };
        }
        section = section.children(common::criteria_progress(
            criteria,
            Some(words.specs.into()),
            cx,
        ));
        if nodes.is_empty() {
            return section
                .child(Typo::caption(words.no_specs).tone(Tone::Secondary))
                .into_any_element();
        }
        for node in nodes {
            section = section.child(self.spec_node(node, cx));
        }
        section.into_any_element()
    }

    fn toggle_fold(
        key: SharedString,
        cx: &mut Context<Self>,
    ) -> impl Fn(&gpui::ClickEvent, &mut gpui::Window, &mut gpui::App) + 'static {
        cx.listener(move |this, _, _, cx| {
            if !this.folded.remove(&key) {
                this.folded.insert(key.clone());
            }
            cx.notify();
        })
    }

    /// `SpecNodeRow`
    fn spec_node(&self, node: &SpecNode, cx: &mut Context<Self>) -> AnyElement {
        let key = SharedString::from(node.node_id.clone());
        let mut row = DisclosureRow::new(
            SharedString::from(format!("spec-node-{}", node.node_id)),
            node.concern_id.clone(),
        )
        .surface(Surface::Plain)
        .open(!self.folded.contains(&key))
        .on_toggle(Self::toggle_fold(key, cx));
        if !node.children.is_empty() || !node.criteria.is_empty() {
            let mut children: Vec<AnyElement> = Vec::new();
            for (part, criteria) in parts(node) {
                children.push(self.spec_part(node, part, &criteria, cx));
            }
            for child in &node.children {
                children.push(self.spec_node(child, cx));
            }
            row = row.child(level(children));
        }
        row.into_any_element()
    }

    /// `SpecPart`
    fn spec_part(
        &self,
        node: &SpecNode,
        part: &str,
        criteria: &[&SpecCriterion],
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = SharedString::from(format!("{}:{part}", node.node_id));
        let rows = criteria
            .iter()
            .map(|criterion| self.criterion_row(node, criterion, cx))
            .collect();
        DisclosureRow::new(
            SharedString::from(format!("spec-part-{key}")),
            part.to_owned(),
        )
        .surface(Surface::Plain)
        .open(!self.folded.contains(&key))
        .on_toggle(Self::toggle_fold(key, cx))
        .child(level(rows))
        .into_any_element()
    }

    /// `CriterionRow`
    fn criterion_row(
        &self,
        node: &SpecNode,
        criterion: &SpecCriterion,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = Self::words(cx);
        let key = SharedString::from(format!("{}:{}", node.node_id, criterion.criterion_id));
        let confirmed = criterion.confirmed;
        let mark = RollingSwap::new(
            SharedString::from(format!("criterion-swap-{key}")),
            confirmed.to_string(),
            {
                let id = key.clone();
                move |_, cx| {
                    if confirmed {
                        SuccessCheck::new(SharedString::from(format!("criterion-check-{id}")))
                            .ring()
                            .still()
                            .into_any_element()
                    } else {
                        icon(Icon::Circle, IconSize::Sm, Ds::get(cx)).into_any_element()
                    }
                }
            },
        );
        let (node_id, criterion_id, revision) = (
            node.node_id.clone(),
            criterion.criterion_id.clone(),
            node.revision,
        );
        let busy = self.pending.contains(&key);
        let pending = key.clone();
        let mut toggle = IconButton::new(
            SharedString::from(format!("criterion-{key}")),
            (words.criterion_state)(&criterion.criterion_id, confirmed),
        )
        .icon(mark)
        .pressed(confirmed)
        .tone(if confirmed {
            ButtonTone::Butler
        } else {
            ButtonTone::Default
        })
        .on_click(cx.listener(move |this, _, _, cx| {
            this.check_criterion(&pending, &node_id, &criterion_id, !confirmed, revision, cx);
        }));
        if busy {
            toggle = toggle.disabled();
        }
        Pad::new()
            .padding_y(Space::Xs)
            .child(
                Stack::new()
                    .gap(Space::Xs)
                    .child(
                        Stack::row()
                            .cross(Cross::Center)
                            .justify(Justify::Between)
                            .child(Typo::code(criterion.criterion_id.clone()))
                            .child(toggle),
                    )
                    .child(Typo::body(criterion.text.clone()).wrap(Wrap::Anywhere)),
            )
            .into_any_element()
    }

    /// `toggle`: one check at a time per criterion; the epic is read again after it.
    fn check_criterion(
        &mut self,
        key: &SharedString,
        node: &str,
        criterion: &str,
        confirmed: bool,
        revision: i64,
        cx: &mut Context<Self>,
    ) {
        if !self.pending.insert(key.clone()) {
            return;
        }
        cx.notify();
        let (node, criterion) = (node.to_owned(), criterion.to_owned());
        let body = json!({ "confirmed": confirmed, "expected_revision": revision });
        let key = key.clone();
        fetch(
            cx,
            move |client| async move { client.check_canon_criterion(&node, &criterion, &body).await },
            move |this: &mut Self, result: Result<Checked, Error>, cx| match result {
                Ok(_) => this.refresh_then(
                    Box::new(move |this, cx| {
                        this.pending.remove(&key);
                        cx.notify();
                    }),
                    cx,
                ),
                Err(error) => {
                    this.pending.remove(&key);
                    this.write_failed(&error, cx);
                }
            },
        );
    }
}
