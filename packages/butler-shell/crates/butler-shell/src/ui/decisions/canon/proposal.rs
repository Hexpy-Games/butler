//! `canon/CanonProposalCard` with its Changes, Fact and Project parts, and `useCanonProposal`.
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::card::{Card, CardPadding, CardRadius};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Cross, Justify, Space, Stack};
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::tooltip::Tooltip;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Window};
use serde_json::{Value, json};

use crate::ui::i18n::canon_proposal::CanonProposalCopy;
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::{
    CanonProposalAnchor, CanonProposalNavigation, CanonProposalProject, CanonProposalProjectOption,
    CanonProposalResolved, CanonProposalState, CanonProposalView,
};

mod changes;
mod epic;
mod project;

use changes::{changes_block, fact};
use epic::epic_block;
use project::project_field;

/// The new-project choice of the project select.
const NEW_PROJECT: &str = "@new";

/// `useCanonProposal` and the card's `target`, `name` and `busy` state.
#[derive(Default)]
pub(super) struct ProposalState {
    pub(super) proposal: Option<CanonProposalView>,
    projects: Vec<CanonProposalProjectOption>,
    requested: bool,
    latest: u64,
    target: String,
    name: String,
    busy: bool,
}

/// One canon proposal card.
pub(super) fn load(
    anchor: &CanonProposalAnchor,
    window: &mut Window,
    cx: &mut App,
) -> Entity<ProposalState> {
    let id = anchor.proposal_id.as_str();
    let state = window.use_keyed_state(
        SharedString::from(format!("canon-proposal-{id}")),
        cx,
        |_, _| ProposalState::default(),
    );
    if !state.update(cx, |state, _| std::mem::replace(&mut state.requested, true)) {
        refresh(&state, id, cx);
        load_projects(&state, cx);
    }
    state
}

/// `refresh`: reads the proposal; only the newest request lands.
fn refresh(state: &Entity<ProposalState>, id: &str, cx: &mut App) {
    let request = state.update(cx, |state, _| {
        state.latest += 1;
        state.latest
    });
    let owned = id.to_owned();
    let fetch = Jobs::run(cx, move |client| async move {
        client.get_canon_proposal(&owned).await.ok()
    });
    let (state, id) = (state.clone(), id.to_owned());
    cx.spawn(async move |cx| {
        let Some(proposal) = fetch
            .await
            .flatten()
            .and_then(|raw| serde_json::from_value::<CanonProposalView>(raw).ok())
        else {
            return;
        };
        state.update(cx, |state, cx| {
            if request != state.latest || proposal.proposal_id != id {
                return;
            }
            if state.target.is_empty() {
                (state.target, state.name) = match &proposal.project {
                    CanonProposalProject::New { new_name } => {
                        (NEW_PROJECT.to_owned(), new_name.clone())
                    }
                    CanonProposalProject::Existing { id, .. } => (
                        id.clone().unwrap_or_else(|| NEW_PROJECT.to_owned()),
                        String::new(),
                    ),
                };
            }
            state.proposal = Some(proposal);
            cx.notify();
        });
    })
    .detach();
}

/// `navigation.projects` of the store: the projects the card can target.
fn load_projects(state: &Entity<ProposalState>, cx: &mut App) {
    let fetch = Jobs::run(
        cx,
        |client| async move { client.list_navigation().await.ok() },
    );
    let state = state.clone();
    cx.spawn(async move |cx| {
        let Some(navigation) = fetch
            .await
            .flatten()
            .and_then(|raw| serde_json::from_value::<CanonProposalNavigation>(raw).ok())
        else {
            return;
        };
        state.update(cx, |state, cx| {
            state.projects = navigation.projects;
            cx.notify();
        });
    })
    .detach();
}

/// `Proposal`
pub(super) fn proposal_card(
    p: &CanonProposalView,
    project_id: Option<&str>,
    state: &Entity<ProposalState>,
    cx: &mut App,
) -> AnyElement {
    let copy = CanonProposalCopy::get(cx);
    let deletes = p.changes.iter().any(|change| change.op == "epic.delete");
    let mixed_delete = deletes && p.changes.iter().any(|change| change.op != "epic.delete");
    if p.state != CanonProposalState::Open {
        return resolved_card(p, copy);
    }
    let creates = p.changes.iter().any(|change| change.op == "epic.create");
    let (target, name, busy, projects) = {
        let s = state.read(cx);
        (s.target.clone(), s.name.clone(), s.busy, s.projects.clone())
    };
    let choose_project = !matches!(
        (&p.project, project_id),
        (CanonProposalProject::Existing { id: Some(id), .. }, Some(open)) if id == open
    );
    let head = proposal_head(p, &target, &name, creates, deletes, copy, cx);
    let project = if choose_project {
        project_field(&p.proposal_id, &target, &name, busy, &projects, state, copy)
    } else {
        let shown = project_name(p, &target, &name, &projects, copy);
        fact(&format!("{}-project", p.proposal_id), copy.project, shown)
    };
    let empty = choose_project && target == NEW_PROJECT && name.trim().is_empty();
    let actions = actions_row(
        p,
        (deletes, mixed_delete, creates),
        (busy, empty),
        choose_project,
        state,
        copy,
    );
    Card::new(SharedString::from(format!(
        "canon-proposal-{}",
        p.proposal_id
    )))
    .radius(CardRadius::Lg)
    .child(
        Stack::new()
            .gap(Space::Lg)
            .child(head)
            .child(project)
            .child(actions),
    )
    .into_any_element()
}

/// Electron `CanonProposalCard.tsx::Proposal`: draft heading and proposed changes.
fn proposal_head(
    p: &CanonProposalView,
    target: &str,
    name: &str,
    creates: bool,
    deletes: bool,
    copy: &CanonProposalCopy,
    cx: &App,
) -> Stack {
    let lang = Ds::get(cx).lang();
    let epics = p
        .epics
        .iter()
        .enumerate()
        .map(|(i, epic)| epic_block(&p.proposal_id, i, epic));
    Stack::new()
        .gap(Space::Md)
        .child(
            Typo::caption(if creates && !deletes {
                copy.draft
            } else {
                copy.changes
            })
            .tone(Tone::Tertiary),
        )
        .child(Typo::caption(if creates {
            CanonProposalCopy::target(
                lang,
                p.plan.as_ref().map(|plan| plan.title.as_str()),
                (target == NEW_PROJECT && !name.is_empty()).then_some(name),
            )
        } else {
            p.target_label.clone()
        }))
        .children(epics)
        .children(changes_block(&p.proposal_id, &p.changes, copy))
}

/// The name shown for the fixed project: the chosen one, else the proposal's own.
fn project_name(
    p: &CanonProposalView,
    target: &str,
    name: &str,
    projects: &[CanonProposalProjectOption],
    copy: &CanonProposalCopy,
) -> String {
    if target == NEW_PROJECT {
        return format!("{}: {name}", copy.new_project);
    }
    projects
        .iter()
        .find(|project| project.id == target)
        .map(|project| project.display_name.clone())
        .unwrap_or_else(|| match &p.project {
            CanonProposalProject::Existing { name, .. } => name.clone(),
            CanonProposalProject::New { .. } => String::new(),
        })
}

/// The card of a resolved proposal: one caption.
fn resolved_card(p: &CanonProposalView, copy: &CanonProposalCopy) -> AnyElement {
    let text = match p.state {
        CanonProposalState::Cancelled => copy.cancelled,
        CanonProposalState::Superseded => copy.superseded,
        _ => copy.stale,
    };
    Card::new(SharedString::from(format!(
        "canon-proposal-{}",
        p.proposal_id
    )))
    .padding(CardPadding::Sm)
    .child(
        Stack::row()
            .cross(Cross::Center)
            .justify(Justify::Between)
            .gap(Space::Sm)
            .child(Typo::caption(text)),
    )
    .into_any_element()
}

/// Cancel and the confirming button, whose label names what the proposal does.
fn actions_row(
    p: &CanonProposalView,
    (deletes, mixed_delete, creates): (bool, bool, bool),
    (busy, empty): (bool, bool),
    choose_project: bool,
    state: &Entity<ProposalState>,
    copy: &CanonProposalCopy,
) -> AnyElement {
    let key = p.proposal_id.clone();
    let on = |outcome: &'static str| {
        let (state, key) = (state.clone(), key.clone());
        move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| {
            resolve(&state, &key, outcome, choose_project, cx);
        }
    };
    let label = match (deletes, mixed_delete, creates) {
        (true, true, true) => copy.add_delete,
        (true, true, false) => copy.change_delete,
        (true, false, _) => copy.delete_epic,
        (false, _, true) => copy.add,
        (false, _, false) => copy.apply,
    };
    let mut cancel = Button::new(SharedString::from(format!("{key}-cancel")))
        .size(Size::Sm)
        .variant(Variant::Ghost)
        .text(copy.cancel)
        .on_click(on("declined"));
    let mut confirm = Button::new(SharedString::from(format!("{key}-confirm")))
        .size(Size::Sm)
        .variant(if deletes {
            Variant::Destructive
        } else {
            Variant::Default
        })
        .text(label)
        .on_click(on("accepted"));
    if busy {
        cancel = cancel.disabled();
        confirm = confirm.disabled();
    }
    if empty {
        confirm = confirm.aria_disabled();
    }
    let mut tip = Tooltip::new(SharedString::from(format!("{key}-confirm-hint"))).wrap();
    if empty {
        tip = tip.label(copy.name);
    }
    button::container(Size::Sm)
        .justify(Justify::End)
        .child(cancel)
        .child(tip.child(confirm))
        .into_any_element()
}

/// `apply`: posts the outcome, reports a refusal, then reads the proposal again.
fn resolve(
    state: &Entity<ProposalState>,
    id: &str,
    outcome: &'static str,
    choose_project: bool,
    cx: &mut App,
) {
    let (target, name) = state.update(cx, |state, cx| {
        state.busy = true;
        cx.notify();
        (state.target.clone(), state.name.clone())
    });
    let mut body = json!({ "outcome": outcome });
    if choose_project {
        if target == NEW_PROJECT {
            body["new_name"] = Value::String(name);
        } else {
            body["project_id"] = Value::String(target);
        }
    }
    let owned = id.to_owned();
    let done = Jobs::run(cx, move |client| async move {
        client.resolve_canon_proposal(&owned, &body).await.ok()
    });
    let copy = CanonProposalCopy::get(cx);
    let (state, id) = (state.clone(), id.to_owned());
    cx.spawn(async move |cx| {
        let raw = done.await.flatten();
        cx.update(|cx| match raw {
            Some(raw) => {
                let result = serde_json::from_value::<CanonProposalResolved>(raw).ok();
                if let Some(CanonProposalResolved { ok: false, error }) = result {
                    let missing = error.is_some_and(|error| error.code == "canon_not_found");
                    toast::show(
                        cx,
                        Toast::error(if missing { copy.missing } else { copy.conflict }),
                    );
                }
            }
            None => {
                toast::show(cx, Toast::error(copy.request_failed));
            }
        });
        cx.update(|cx| refresh(&state, &id, cx));
        state.update(cx, |state, cx| {
            state.busy = false;
            cx.notify();
        });
    })
    .detach();
}
