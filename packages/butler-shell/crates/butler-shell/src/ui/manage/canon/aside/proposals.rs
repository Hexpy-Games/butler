//! `EpicMcpProposals.tsx`: the spec changes an MCP client proposed, each as a changed-line diff
//! the owner applies or denies.
use butler_ds::ui::blocks::changed_line_diff::{ChangedLineDiff, DiffLine, LineType};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Justify, Space, Stack};
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::{Typo, Wrap};
use butler_shell_client::Error;
use gpui::{
    AnyElement, App, ClickEvent, Context, IntoElement as _, ParentElement as _, SharedString,
    Window,
};
use serde::Deserialize;
use serde_json::json;

use super::inspector::EpicInspector;
use crate::ui::manage::canon::common;
use crate::ui::source::fetch::fetch;
use crate::ui::source::wire::CanonMcpProposal;

enum Op {
    Keep,
    Delete,
    Insert,
}

/// The edit script between two line lists (an LCS, as `diffArrays` finds), a changed run
/// listing its deletions before its insertions.
fn script(old: &[&str], new: &[&str]) -> Vec<Op> {
    let head = old.iter().zip(new).take_while(|(a, b)| a == b).count();
    let tail = old[head..]
        .iter()
        .rev()
        .zip(new[head..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let (a, b) = (&old[head..old.len() - tail], &new[head..new.len() - tail]);
    let mut lcs = vec![vec![0_u32; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    let mut ops: Vec<Op> = (0..head).map(|_| Op::Keep).collect();
    let (mut i, mut j) = (0, 0);
    let mut run: (Vec<Op>, Vec<Op>) = (Vec::new(), Vec::new());
    let flush = |ops: &mut Vec<Op>, run: &mut (Vec<Op>, Vec<Op>)| {
        ops.append(&mut run.0);
        ops.append(&mut run.1);
    };
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] {
            flush(&mut ops, &mut run);
            ops.push(Op::Keep);
            (i, j) = (i + 1, j + 1);
        } else if j == b.len() || (i < a.len() && lcs[i + 1][j] >= lcs[i][j + 1]) {
            run.0.push(Op::Delete);
            i += 1;
        } else {
            run.1.push(Op::Insert);
            j += 1;
        }
    }
    flush(&mut ops, &mut run);
    ops.extend((0..tail).map(|_| Op::Keep));
    ops
}

/// One changed line of a proposal's diff, kept so the render only builds the DS lines.
pub(super) struct Row {
    kind: LineType,
    text: SharedString,
    number: u32,
}

impl Row {
    fn line(&self) -> DiffLine {
        let line = DiffLine::new(self.kind, self.text.clone());
        match self.kind {
            LineType::Deleted => line.old_line(self.number),
            LineType::Added => line.new_line(self.number),
        }
    }
}

/// `proposalLines`: the deleted and added lines, numbered in their own files.
fn lines(current: &str, proposed: &str) -> Vec<Row> {
    let split = |text: &str| -> Vec<String> {
        if text.is_empty() {
            Vec::new()
        } else {
            text.split('\n').map(str::to_owned).collect()
        }
    };
    let (old, new) = (split(current), split(proposed));
    let (old_refs, new_refs): (Vec<&str>, Vec<&str>) = (
        old.iter().map(String::as_str).collect(),
        new.iter().map(String::as_str).collect(),
    );
    let number = |n: usize| u32::try_from(n + 1).unwrap_or(u32::MAX);
    let (mut old_at, mut new_at) = (0, 0);
    let mut out = Vec::new();
    for op in script(&old_refs, &new_refs) {
        match op {
            Op::Keep => {
                old_at += 1;
                new_at += 1;
            }
            Op::Delete => {
                out.push(Row {
                    kind: LineType::Deleted,
                    text: old[old_at].clone().into(),
                    number: number(old_at),
                });
                old_at += 1;
            }
            Op::Insert => {
                out.push(Row {
                    kind: LineType::Added,
                    text: new[new_at].clone().into(),
                    number: number(new_at),
                });
                new_at += 1;
            }
        }
    }
    out
}

/// `{ ok?, error?: { code } }`
#[derive(Deserialize)]
struct Resolved {
    #[serde(default)]
    error: Option<ResolveError>,
}

#[derive(Deserialize)]
struct ResolveError {
    code: String,
}

impl EpicInspector {
    /// The diff of every loaded proposal, computed once per proposal id (a proposal's bodies do
    /// not change) and dropped with the proposal.
    pub(super) fn sync_diffs(&mut self) {
        let proposals: &[CanonMcpProposal] = self
            .detail
            .as_ref()
            .and_then(|detail| detail.proposals.as_deref())
            .unwrap_or_default();
        self.diffs
            .retain(|id, _| proposals.iter().any(|proposal| proposal.id == *id));
        for proposal in proposals {
            self.diffs.entry(proposal.id.clone()).or_insert_with(|| {
                lines(
                    proposal.current_body.as_deref().unwrap_or_default(),
                    &proposal.proposed_body,
                )
            });
        }
    }

    /// `EpicMcpProposals`
    pub(super) fn proposals(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(detail) = self.detail.as_ref() else {
            return Stack::new().into_any_element();
        };
        let rows: Vec<AnyElement> = detail
            .proposals
            .iter()
            .flatten()
            .map(|proposal| self.proposal(proposal, cx))
            .collect();
        Stack::new()
            .gap(Space::Lg)
            .children(rows)
            .into_any_element()
    }

    /// `McpProposal`
    fn proposal(&self, proposal: &CanonMcpProposal, cx: &mut Context<Self>) -> AnyElement {
        let words = Self::words(cx);
        let lang = Ds::get(cx).lang();
        let person = common::person_name(cx);
        let actor = common::actor_label(&proposal.actor, &person, lang);
        let key = SharedString::from(format!("proposal:{}", proposal.id));
        let busy = self.pending.contains(&key);
        let diff = ChangedLineDiff::new(
            SharedString::from(format!("proposal-{}", proposal.id)),
            self.diffs
                .get(&proposal.id)
                .map(|rows| rows.iter().map(Row::line).collect())
                .unwrap_or_default(),
        );
        let owner = cx.entity();
        let resolve = |outcome: &'static str| {
            let (id, key, owner) = (proposal.id.clone(), key.clone(), owner.clone());
            move |_: &ClickEvent, _: &mut Window, cx: &mut App| {
                owner.update(cx, |this, cx| this.resolve_proposal(&id, &key, outcome, cx));
            }
        };
        let (deny, apply) = (
            Button::new(SharedString::from(format!("proposal-deny-{}", proposal.id)))
                .size(Size::Sm)
                .variant(Variant::Ghost)
                .text(words.deny)
                .on_click(resolve("declined")),
            Button::new(SharedString::from(format!(
                "proposal-apply-{}",
                proposal.id
            )))
            .size(Size::Sm)
            .text(words.apply)
            .on_click(resolve("accepted")),
        );
        Stack::new()
            .gap(Space::Sm)
            .child(
                Typo::panel_section_title(format!("{} · {actor}", words.proposal))
                    .wrap(Wrap::Anywhere),
            )
            .child(Typo::body(proposal.summary.clone()).wrap(Wrap::Pre))
            .child(diff)
            .child(
                button::container(Size::Sm)
                    .justify(Justify::End)
                    .child(if busy { deny.disabled() } else { deny })
                    .child(if busy { apply.disabled() } else { apply }),
            )
            .into_any_element()
    }

    /// `resolve`: the epic is read again whatever the answer was.
    fn resolve_proposal(
        &mut self,
        id: &str,
        key: &SharedString,
        outcome: &'static str,
        cx: &mut Context<Self>,
    ) {
        if !self.pending.insert(key.clone()) {
            return;
        }
        cx.notify();
        let (id, key) = (id.to_owned(), key.clone());
        fetch(
            cx,
            move |client| async move {
                client
                    .resolve_canon_proposal(&id, &json!({ "outcome": outcome }))
                    .await
            },
            move |this: &mut Self, result: Result<Resolved, Error>, cx| {
                let words = Self::words(cx);
                // CARVE-OUT(G-codes): a refused POST is told by its 409 status.
                let conflict = match &result {
                    Ok(answer) => answer
                        .error
                        .as_ref()
                        .map(|error| error.code == "canon_conflict"),
                    Err(Error::Http(409)) => Some(true),
                    Err(_) => Some(false),
                };
                match conflict {
                    Some(true) => {
                        toast::show(cx, Toast::message(words.conflict));
                    }
                    Some(false) => {
                        toast::show(cx, Toast::error(words.request_failed));
                    }
                    None => {}
                }
                this.refresh_then(
                    Box::new(move |this, cx| {
                        this.pending.remove(&key);
                        cx.notify();
                    }),
                    cx,
                );
            },
        );
    }
}
