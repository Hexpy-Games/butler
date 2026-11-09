//! `canonMove.ts`: the write a drop makes and the message it leaves.
use butler_ds::ui::blocks::kanban_board::KanbanMove;
use butler_shell_client::{Error, ShellClient};
use serde_json::Value;

use super::copy::Words;
use super::lanes::{Spec, find_card, lane_status, moved_canon_order, parse_canon_lane};
use crate::ui::source::wire::{CanonOrderInput, CanonOverview, EpicCard, EpicInput, Patch};

/// The one request a drop makes.
pub(super) enum Write {
    Plan { id: String, body: Value },
    Backlog { project: String, body: Value },
    Epic { id: String, body: Value },
}

impl Write {
    pub(super) async fn send(self, client: ShellClient) -> Result<Value, Error> {
        match self {
            Self::Plan { id, body } => client.order_canon_plan(&id, &body).await,
            Self::Backlog { project, body } => client.order_canon_backlog(&project, &body).await,
            Self::Epic { id, body } => client.edit_canon_epic(&id, &body).await,
        }
    }
}

/// `persistCanonMove`: the write, and the message to toast once it lands.
pub(super) fn persist_move(
    canon: &CanonOverview,
    mv: &KanbanMove,
    words: &Words,
) -> Option<(Write, String)> {
    let spec = Spec::of(mv);
    let from = parse_canon_lane(&spec.from)?;
    let to = parse_canon_lane(&spec.to)?;
    let epic = find_card(canon, &spec.item)?;
    let plan = to
        .plan
        .as_deref()
        .and_then(|id| canon.plans.iter().find(|plan| plan.plan.id == id));
    if spec.from == spec.to {
        let cards: &[EpicCard] = plan.map_or(&canon.backlog, |plan| &plan.works);
        let work_ids = moved_canon_order(cards, &spec)?;
        let write = match plan {
            Some(plan) => {
                let order = CanonOrderInput {
                    work_ids,
                    expected_revision: plan.plan.revision,
                };
                Write::Plan {
                    id: plan.plan.id.clone(),
                    body: serde_json::to_value(order).ok()?,
                }
            }
            None => {
                let order = CanonOrderInput {
                    work_ids,
                    expected_revision: canon.backlog_revision,
                };
                Write::Backlog {
                    project: canon.project_id.clone(),
                    body: serde_json::to_value(order).ok()?,
                }
            }
        };
        return Some((write, words.reordered.to_owned()));
    }
    let moved_plan = from.plan != to.plan;
    let mut input = EpicInput {
        expected_revision: Some(epic.revision),
        status: to
            .status
            .filter(|status| *status != lane_status(epic.canon_status)),
        ..EpicInput::default()
    };
    if moved_plan {
        input.plan_id = to.plan.clone().map_or(Patch::Clear, Patch::Set);
        input.before_id.clone_from(&spec.before);
    }
    let message = if moved_plan {
        words.moved(plan.map_or(words.backlog, |plan| plan.plan.title.as_str()))
    } else {
        let status = to.status.map_or("", |status| words.lane_label(status));
        words.card_status_changed(&epic.title, status)
    };
    let write = Write::Epic {
        id: epic.id.clone(),
        body: serde_json::to_value(input).ok()?,
    };
    Some((write, message))
}
