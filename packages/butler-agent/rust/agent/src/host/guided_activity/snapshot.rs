//! Source activity snapshot order and correlation across an authority suspension.

use indexmap::IndexMap;

use crate::btcc::{
    ActivityGroup, BtccError, GuidedActivityBinding, GuidedActivitySnapshot, PendingTool, WorkStage,
};

use super::{ActivityBinding, Group, Pending, State};

fn stage(value: WorkStage) -> &'static str {
    match value {
        WorkStage::Conception => "conception",
        WorkStage::Planning => "planning",
        WorkStage::Execution => "execution",
        WorkStage::Review => "review",
        WorkStage::Validation => "validation",
        WorkStage::Reporting => "reporting",
    }
}

fn parse_stage(value: &str) -> Result<WorkStage, BtccError> {
    match value {
        "conception" => Ok(WorkStage::Conception),
        "planning" => Ok(WorkStage::Planning),
        "execution" => Ok(WorkStage::Execution),
        "review" => Ok(WorkStage::Review),
        "validation" => Ok(WorkStage::Validation),
        "reporting" => Ok(WorkStage::Reporting),
        _ => Err(invalid()),
    }
}

fn invalid() -> BtccError {
    BtccError::new(
        "guided_activity_snapshot_invalid",
        "Saved activity presentation is invalid",
    )
}

pub(super) fn capture(state: &State) -> GuidedActivitySnapshot {
    GuidedActivitySnapshot {
        groups: state
            .groups
            .values()
            .map(|group| ActivityGroup {
                activity_id: group.id.clone(),
                display_stage: group.stage.map(|value| stage(value).to_owned()),
                deferred_until_accepted: group.deferred,
                interface_content: group.interface_content.clone(),
                title: group.title.clone(),
                summary: group.summary.clone(),
                rationale: group.rationale.clone(),
                next_step: group.next_step.clone(),
                preceding_ids: group.preceding.clone(),
                following_ids: group.following.clone(),
                starts_execution: group.starts_execution.then_some(true),
                resumes_work: group.resumes_work.then_some(true),
                next_execution_title: group.next_execution_title.clone(),
                published: group.published,
                extensions: group.extensions.clone(),
            })
            .collect(),
        pending_tools: state
            .pending
            .iter()
            .map(|pending| PendingTool {
                name: pending.name.clone(),
                claimed: pending.claimed,
                group_id: pending.group_id.clone(),
            })
            .collect(),
        tool_bindings: state
            .bindings
            .iter()
            .map(|(id, binding)| {
                (
                    id.clone(),
                    GuidedActivityBinding {
                        activity_id: binding.id.clone(),
                        display_stage: binding.stage.map(|value| stage(value).to_owned()),
                        deferred_until_accepted: binding.deferred,
                    },
                )
            })
            .collect(),
        managed: state.managed,
        current_activity_id: state.current.clone(),
        fallback_activity_id: state.fallback.clone(),
        pending_execution_title: state.pending_title.clone(),
        pending_execution: None,
        pending_stage: state.pending_stage.map(|value| stage(value).to_owned()),
        extensions: Default::default(),
    }
}

pub(super) fn restore(snapshot: &GuidedActivitySnapshot) -> Result<State, BtccError> {
    let mut groups = IndexMap::with_capacity(snapshot.groups.len());
    for group in &snapshot.groups {
        groups.insert(
            group.activity_id.clone(),
            Group {
                id: group.activity_id.clone(),
                stage: group
                    .display_stage
                    .as_deref()
                    .map(parse_stage)
                    .transpose()?,
                deferred: group.deferred_until_accepted,
                title: group.title.clone(),
                summary: group.summary.clone(),
                rationale: group.rationale.clone(),
                next_step: group.next_step.clone(),
                interface_content: group.interface_content.clone(),
                preceding: group.preceding_ids.clone(),
                following: group.following_ids.clone(),
                starts_execution: group.starts_execution.unwrap_or(false),
                resumes_work: group.resumes_work.unwrap_or(false),
                next_execution_title: group.next_execution_title.clone(),
                published: group.published,
                extensions: group.extensions.clone(),
            },
        );
    }
    for group in groups.values() {
        if group
            .preceding
            .iter()
            .chain(&group.following)
            .any(|id| !groups.contains_key(id))
        {
            return Err(invalid());
        }
    }
    let pending = snapshot
        .pending_tools
        .iter()
        .map(|tool| {
            if !groups.contains_key(&tool.group_id) {
                return Err(invalid());
            }
            Ok(Pending {
                name: tool.name.clone(),
                group_id: tool.group_id.clone(),
                claimed: tool.claimed,
            })
        })
        .collect::<Result<Vec<_>, BtccError>>()?;
    let mut bindings = IndexMap::with_capacity(snapshot.tool_bindings.len());
    for (id, binding) in &snapshot.tool_bindings {
        bindings.insert(
            id.clone(),
            ActivityBinding {
                id: binding.activity_id.clone(),
                stage: binding
                    .display_stage
                    .as_deref()
                    .map(parse_stage)
                    .transpose()?,
                deferred: binding.deferred_until_accepted,
            },
        );
    }
    let current = snapshot
        .current_activity_id
        .as_ref()
        .filter(|id| groups.contains_key(*id))
        .cloned();
    let fallback = snapshot
        .fallback_activity_id
        .as_ref()
        .filter(|id| groups.contains_key(*id))
        .cloned();
    let pending_stage = snapshot
        .pending_stage
        .as_deref()
        .map(parse_stage)
        .transpose()?
        .or_else(|| {
            (snapshot.pending_execution == Some(true) || snapshot.pending_execution_title.is_some())
                .then_some(WorkStage::Execution)
        });
    Ok(State {
        groups,
        pending,
        bindings,
        managed: snapshot.managed,
        current,
        fallback,
        pending_stage,
        pending_title: snapshot.pending_execution_title.clone(),
    })
}
