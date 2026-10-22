use super::*;
use crate::work_chain::Placement;
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Batch {
    ops: Vec<Op>,
    expected_graph_revisions: BTreeMap<String, i64>,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Op {
    MoveToNewStep {
        chain_id: String,
        work_id: String,
        index: usize,
    },
    JoinStack {
        chain_id: String,
        work_id: String,
        target: String,
    },
    MoveToChain {
        chain_id: String,
        work_id: String,
        target_chain_id: String,
        index: Option<usize>,
        target: Option<String>,
    },
    StartNow {
        chain_id: String,
        work_id: String,
    },
    SplitStack {
        chain_id: String,
        index: usize,
    },
    Delete {
        chain_id: String,
        work_id: String,
    },
    DecideHold {
        chain_id: String,
        id: String,
        decision: Decision,
    },
}
impl Op {
    fn chains(&self) -> Vec<&str> {
        match self {
            Self::MoveToChain {
                chain_id,
                target_chain_id,
                ..
            } => vec![chain_id, target_chain_id],
            Self::MoveToNewStep { chain_id, .. }
            | Self::JoinStack { chain_id, .. }
            | Self::StartNow { chain_id, .. }
            | Self::SplitStack { chain_id, .. }
            | Self::Delete { chain_id, .. }
            | Self::DecideHold { chain_id, .. } => vec![chain_id],
        }
    }
    fn queue_edit(self, ctx: &Context) -> Result<QueueEdit> {
        Ok(match self {
            Self::MoveToNewStep {
                chain_id,
                work_id,
                index,
            } => QueueEdit::MoveToNewStep {
                chain_id,
                work_id,
                index,
            },
            Self::JoinStack {
                chain_id,
                work_id,
                target,
            } => QueueEdit::JoinStack {
                chain_id,
                work_id,
                target,
            },
            Self::MoveToChain {
                chain_id,
                work_id,
                target_chain_id,
                index,
                target,
            } => {
                let placement = match (index, target) {
                    (Some(i), None) => Placement::NewStep(i),
                    (None, Some(t)) => Placement::Stack(WorkId(t)),
                    _ => return Err(Error::Invalid("one destination required")),
                };
                QueueEdit::MoveBetween {
                    chain_id,
                    work_id,
                    target_chain_id,
                    placement,
                }
            }
            Self::StartNow { chain_id, work_id } => QueueEdit::Detach {
                chain_id,
                work_id,
                new_chain_id: IdGenerator::global_next(IdKind::Chain, ctx.now)?,
            },
            Self::SplitStack { chain_id, index } => QueueEdit::SplitStack { chain_id, index },
            Self::Delete { chain_id, work_id } => QueueEdit::Delete { chain_id, work_id },
            Self::DecideHold { .. } => return Err(Error::Invalid("hold is not a membership edit")),
        })
    }
}
pub(super) fn edit(
    tx: &Transaction<'_>,
    ctx: &Context,
    session: &str,
    value: Value,
) -> Result<Value> {
    let batch: Batch = input(value)?;
    if batch.ops.is_empty() {
        return Err(Error::Invalid("ops required"));
    }
    for (id, expected) in &batch.expected_graph_revisions {
        let chain = load_chain(tx, id)?;
        if chain.session_id != session {
            return Err(Error::CrossChat);
        }
        if chain.graph_revision != *expected {
            return Err(Error::Conflict {
                current: json!({"revision":chain.graph_revision}),
            });
        }
    }
    for op in batch.ops {
        let mut graphs = Vec::new();
        let mut works = Vec::new();
        for id in op.chains() {
            if !batch.expected_graph_revisions.contains_key(id) {
                return Err(Error::Invalid("missing graph revision"));
            }
            let chain = load_chain(tx, id)?;
            graphs.push((id.to_owned(), chain.graph_revision));
            for member in chain.members {
                works.push((text(&member, "id")?.to_owned(), revision(&member)?));
            }
        }
        if let Op::DecideHold {
            chain_id,
            id,
            decision,
        } = op
        {
            let hold = one(tx, super::super::sql::HOLD, [&id])?;
            if hold["chain_id"] != chain_id {
                return Err(Error::CrossChat);
            }
            decide_hold(tx, ctx, &id, revision(&hold)?, graphs[0].1, decision)?;
        } else {
            edit_queue(tx, ctx, &graphs, &works, &[op.queue_edit(ctx)?])?;
        }
    }
    queue(tx, session)
}
