//! `CanonDecisionPanels`, `InitiatedPanels`, `InitiatedApprovalLine`, `useInitiatedDecision`,
//! `TurnDecisionRow` and `WorkDecisionBody`. `WorkDecisionBody` is `chat/activity/blocks.rs`.
mod initiated;
mod proposal;

use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::composer_decision_panel::{Action, ComposerDecisionPanel};
use butler_ds::ui::blocks::composer_panel::Placement;
use butler_ds::ui::button::Variant;
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::{Tone, Typo};
use butler_shell_client::{Error, ShellClient};
use gpui::{
    AnyElement, App, Entity, Global, IntoElement as _, ParentElement as _, SharedString,
    Styled as _, Window, div,
};
use serde_json::json;

use super::DecisionCtx;
use crate::ui::i18n::initiated::Initiated;
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::{
    InitiatedOriginPanel, InitiatedOriginPanelCanonHoldState,
    InitiatedOriginPanelCanonTakeHereState, MessageRecord,
};

pub(crate) use initiated::{ApprovalLineText, initiated_approval_line, turn_decision_row};

type Open = Rc<dyn Fn(&str, &mut App)>;
type OpenSettings = Rc<dyn Fn(&mut App)>;

/// What the panels need from the shell: the navigation targets of `useButlerStore` and the
/// session refresh that follows a conflicting decision (`refreshSessionView`). The shell installs
/// it as a global.
#[derive(Clone, Default)]
pub(crate) struct InitiatedHooks {
    /// `openSession`
    pub(crate) open_session: Option<Open>,
    /// `openSessionObserver`
    pub(crate) open_observer: Option<Open>,
    /// `setView({ kind: "automation-detail", automationId })`
    pub(crate) open_automation: Option<Open>,
    /// `openSettings("memory")`
    pub(crate) open_memory_settings: Option<OpenSettings>,
    /// `refreshSessionView`
    pub(crate) refresh_session: Option<Open>,
}

impl Global for InitiatedHooks {}

fn hooks(cx: &App) -> InitiatedHooks {
    cx.try_global::<InitiatedHooks>()
        .cloned()
        .unwrap_or_default()
}

fn call(pick: fn(&InitiatedHooks) -> &Option<Open>, id: &str, cx: &mut App) {
    if let Some(open) = pick(&hooks(cx)).clone() {
        open(id, cx);
    }
}

/// How a canon panel stands once decided (`CanonHoldPanel.state`, `CanonTakeHerePanel.state`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Settled {
    Pending,
    Deleted,
    Continued,
    Resolved,
    Taken,
}

/// The state of one panel: `useDecision`'s `busy` and `useStateForPanel`'s settled state, kept
/// with the server state it was set against.
#[derive(Default)]
pub(super) struct PanelState {
    busy: bool,
    local: Option<(String, Settled)>,
}

/// `useDecision().run`: one decision at a time. A failure shows a toast; a conflict (409) also
/// refreshes `refresh` first. `done` runs on success.
pub(super) fn run_decision<F, Fut>(
    state: &Entity<PanelState>,
    refresh: Option<String>,
    work: F,
    done: impl FnOnce(&mut PanelState) + 'static,
    window: &mut Window,
    cx: &mut App,
) where
    F: FnOnce(ShellClient) -> Fut + Send + 'static,
    Fut: Future<Output = Result<(), Error>> + Send + 'static,
{
    if state.update(cx, |state, _| std::mem::replace(&mut state.busy, true)) {
        return;
    }
    window.refresh();
    let request = Jobs::run(cx, work);
    let state = state.clone();
    cx.spawn(async move |cx| {
        let result = request.await;
        let ok = matches!(result, Some(Ok(())));
        let conflict = matches!(result, Some(Err(Error::Http(409))));
        cx.update(|cx| {
            state.update(cx, |state, cx| {
                state.busy = false;
                if ok {
                    done(state);
                }
                cx.notify();
            });
            if ok {
                return;
            }
            let copy = Initiated::get(cx);
            if let (true, Some(session), Some(refresh)) =
                (conflict, refresh, hooks(cx).refresh_session)
            {
                refresh(&session, cx);
            }
            let text = if conflict {
                copy.already_handled
            } else {
                copy.failed
            };
            toast::show(cx, Toast::error(text));
        });
    })
    .detach();
}

impl PanelState {
    /// The panel's own state, until the server's state changes (`useStateForPanel`).
    fn shown(&self, key: &str, server: Settled) -> Settled {
        match &self.local {
            Some((local_key, settled)) if local_key == key => *settled,
            _ => server,
        }
    }
}

pub(super) fn panel_state(
    id: &SharedString,
    window: &mut Window,
    cx: &mut App,
) -> Entity<PanelState> {
    window.use_keyed_state(id.clone(), cx, |_, _| PanelState::default())
}

/// A decided panel: its outcome as a secondary caption.
fn settled_caption(text: &'static str) -> AnyElement {
    Typo::caption(text).tone(Tone::Secondary).into_any_element()
}

/// The settled state to show.
fn visible(state: &Entity<PanelState>, key: &str, server: Settled, cx: &App) -> Settled {
    state.read(cx).shown(key, server)
}

/// `CanonHold`
fn canon_hold(
    session_id: &str,
    epic_id: &str,
    epic_title: &str,
    server: &InitiatedOriginPanelCanonHoldState,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let copy = Initiated::get(cx);
    let id = SharedString::from(format!("canon-hold-{session_id}-{epic_id}"));
    let state = panel_state(&id, window, cx);
    let key = format!("{session_id}:{epic_id}:{server:?}");
    let server = match server {
        InitiatedOriginPanelCanonHoldState::Pending => Settled::Pending,
        InitiatedOriginPanelCanonHoldState::Deleted => Settled::Deleted,
        InitiatedOriginPanelCanonHoldState::Resolved => Settled::Resolved,
        _ => Settled::Continued,
    };
    let shown = visible(&state, &key, server, cx);
    if shown != Settled::Pending {
        return settled_caption(match shown {
            Settled::Deleted => copy.removed,
            Settled::Resolved => copy.resolved,
            _ => copy.continued,
        });
    }
    let decide = |proceed: bool| {
        let (state, key) = (state.clone(), key.clone());
        let (session, epic) = (session_id.to_owned(), epic_id.to_owned());
        move |window: &mut Window, cx: &mut App| {
            let (call_session, call_epic) = (session.clone(), epic.clone());
            let (state_key, settled) = (
                key.clone(),
                if proceed {
                    Settled::Continued
                } else {
                    Settled::Deleted
                },
            );
            run_decision(
                &state,
                Some(session.clone()),
                move |client| async move {
                    let decision = if proceed { "continue" } else { "delete" };
                    client
                        .decide_canon_hold(
                            &call_session,
                            &call_epic,
                            &json!({ "decision": decision }),
                        )
                        .await
                        .map(|_| ())
                },
                move |state| state.local = Some((state_key, settled)),
                window,
                cx,
            );
        }
    };
    let session = session_id.to_owned();
    ComposerDecisionPanel::new(
        id,
        Icon::CircleAlert,
        epic_title.to_owned(),
        move |_, _, cx| {
            call(|hooks| &hooks.open_session, &session, cx);
        },
    )
    .placement(Placement::Conversation)
    .action(Action::new(copy.remove, Variant::Secondary, decide(false)))
    .action(Action::new(copy.proceed, Variant::Default, decide(true)))
    .into_any_element()
}

/// `CanonTakeHere`
fn canon_take_here(
    (session_id, epic_id, epic_title, other_session_id): (&str, &str, &str, &str),
    server: &InitiatedOriginPanelCanonTakeHereState,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let copy = Initiated::get(cx);
    let id = SharedString::from(format!("canon-take-here-{session_id}-{epic_id}"));
    let state = panel_state(&id, window, cx);
    let key = format!("{session_id}:{epic_id}:{server:?}");
    let server = match server {
        InitiatedOriginPanelCanonTakeHereState::Pending => Settled::Pending,
        InitiatedOriginPanelCanonTakeHereState::Deleted => Settled::Deleted,
        _ => Settled::Taken,
    };
    let shown = visible(&state, &key, server, cx);
    if shown != Settled::Pending {
        return settled_caption(if shown == Settled::Deleted {
            copy.epic_deleted
        } else {
            copy.taken
        });
    }
    let (session, epic) = (session_id.to_owned(), epic_id.to_owned());
    let take = {
        let (state, key) = (state.clone(), key.clone());
        move |window: &mut Window, cx: &mut App| {
            let (call_session, call_epic) = (session.clone(), epic.clone());
            let state_key = key.clone();
            run_decision(
                &state,
                Some(session.clone()),
                move |client| async move {
                    client
                        .take_canon_here(&call_session, &call_epic, &json!({}))
                        .await
                        .map(|_| ())
                },
                move |state| state.local = Some((state_key, Settled::Taken)),
                window,
                cx,
            );
        }
    };
    let (open_title, open_action) = (other_session_id.to_owned(), other_session_id.to_owned());
    ComposerDecisionPanel::new(
        id,
        Icon::CircleAlert,
        epic_title.to_owned(),
        move |_, _, cx| {
            call(|hooks| &hooks.open_session, &open_title, cx);
        },
    )
    .placement(Placement::Conversation)
    .action(Action::new(
        copy.open_other,
        Variant::Secondary,
        move |_, cx| {
            call(|hooks| &hooks.open_session, &open_action, cx);
        },
    ))
    .action(Action::new(copy.take, Variant::Default, take))
    .into_any_element()
}

/// The canon-hold and take-here panels of an initiated message (`InitiatedPanels`).
pub(super) fn canon_panel(
    panel: &InitiatedOriginPanel,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    match panel {
        InitiatedOriginPanel::CanonHold {
            session_id,
            epic_id,
            epic_title,
            state,
        } => Some(canon_hold(
            session_id, epic_id, epic_title, state, window, cx,
        )),
        InitiatedOriginPanel::CanonTakeHere {
            session_id,
            epic_id,
            epic_title,
            other_session_id,
            state,
        } => Some(canon_take_here(
            (session_id, epic_id, epic_title, other_session_id),
            state,
            window,
            cx,
        )),
        _ => None,
    }
}

/// `InitiatedPanels` of one message.
pub(crate) fn initiated_panels(
    _ctx: DecisionCtx<'_>,
    message: &MessageRecord,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let panels = initiated::initiated_panels(message.initiated.as_ref(), window, cx);
    (!panels.is_empty()).then(|| div().flex().flex_col().children(panels).into_any_element())
}

/// A message's canon proposal cards (`message.canon_proposals`).
pub(crate) fn canon_proposal_cards(
    ctx: DecisionCtx<'_>,
    message: &MessageRecord,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let anchors = message
        .canon_proposals
        .as_deref()
        .filter(|anchors| !anchors.is_empty())?;
    let loaded: Vec<_> = anchors
        .iter()
        .filter_map(|anchor| {
            let state = proposal::load(anchor, window, cx);
            let p = state.read(cx).proposal.clone()?;
            (p.proposal_id == anchor.proposal_id).then_some((p, state))
        })
        .collect();
    let mut seen = std::collections::HashSet::new();
    let mut cards = Vec::new();
    for (p, state) in &loaded {
        if p.state != crate::ui::source::wire::CanonProposalState::Applied {
            cards.push(proposal::proposal_card(
                p,
                ctx.view.project_id.as_deref(),
                state,
                cx,
            ));
            continue;
        }
        let project = project_of(p);
        if !seen.insert(project) {
            continue;
        }
        let group: Vec<_> = loaded
            .iter()
            .map(|(p, _)| p)
            .filter(|other| {
                other.state == crate::ui::source::wire::CanonProposalState::Applied
                    && project_of(other) == project
            })
            .collect();
        cards.push(applied_receipt(&group, window, cx));
    }
    Some(div().flex().flex_col().children(cards).into_any_element())
}

/// Electron `CanonProposalCard.tsx::projectOf`.
fn project_of(p: &crate::ui::source::wire::CanonProposalView) -> Option<&str> {
    match &p.project {
        crate::ui::source::wire::CanonProposalProject::Existing { id, .. } => id.as_deref(),
        crate::ui::source::wire::CanonProposalProject::New { .. } => None,
    }
}

/// Electron `CanonProposalCard.tsx::AppliedReceipt`: one receipt per project in anchor order.
fn applied_receipt(
    group: &[&crate::ui::source::wire::CanonProposalView],
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    use crate::ui::i18n::canon_proposal::{CanonProposalCopy, receipt};
    use crate::ui::manage::canon::chat_cards::chat_epic_cards;
    use crate::ui::manage::dashboard::open_canon_epic;
    use butler_ds::ui::button::{Button, Size};
    use butler_ds::ui::context::Ds;
    use butler_ds::ui::layout::{Border, Box, Radius, Space, Surface};
    use butler_ds::ui::section::Section;
    let first = group[0];
    let project = project_of(first);
    let changes: Vec<_> = group
        .iter()
        .flat_map(|p| p.changes.iter().cloned())
        .collect();
    let mut seen = std::collections::HashSet::new();
    let ids: Vec<_> = changes
        .iter()
        .filter(|change| {
            matches!(
                change.op.as_str(),
                "epic.create" | "epic.edit" | "epic.move"
            )
        })
        .filter_map(|change| change.id.as_ref())
        .filter(|id| !id.is_empty() && seen.insert((*id).clone()))
        .cloned()
        .collect();
    let (target, epic) = (project.map(str::to_owned), ids.first().cloned());
    let open = Button::new(SharedString::from(format!(
        "receipt-open-{}",
        first.proposal_id
    )))
    .size(Size::Sm)
    .variant(Variant::Outline)
    .text(CanonProposalCopy::get(cx).open_action)
    .on_click(move |_, _, cx| {
        if let Some(project) = &target {
            open_canon_epic(project, epic.as_deref(), cx);
        }
    });
    let mut section = Section::new(SharedString::from(format!("receipt-{}", first.proposal_id)))
        .title(receipt(Ds::get(cx).lang(), &changes))
        .actions(butler_ds::ui::button::container(Size::Sm).child(open));
    if let Some(project) = project.filter(|_| !ids.is_empty()) {
        section = section.child(chat_epic_cards(
            &first.proposal_id,
            project,
            &ids,
            None,
            window,
            cx,
        ));
    }
    let receipt = Box::new()
        .surface(Surface::Muted)
        .border(Border::Hairline)
        .radius(Radius::Panel)
        .padding(Space::Md)
        .child(section);
    crate::ui::widgets::anchor(div(), "canon-proposal-card")
        .child(crate::ui::widgets::anchor(div(), "canon-proposal-state-applied").child(receipt))
        .into_any_element()
}
