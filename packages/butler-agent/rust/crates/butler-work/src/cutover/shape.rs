//! Recognize the flat step/stack order, without inventing dependencies. General
//! DAGs remain hidden parts of a single Task, preserving their exact edges.
use crate::{
    store::{Error, Result},
    work_chain::{Chain, Step, validate_part_dag},
    work_types::TaskId,
};
use serde::Deserialize;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub action_key: String,
    pub description: String,
    pub dependency_keys: Vec<String>,
}

pub struct Layout {
    pub chains: Option<Vec<Chain>>,
    pub edges: Vec<(TaskId, TaskId)>,
}

pub fn layout(actions: &[Action]) -> Result<Layout> {
    let ids: Vec<_> = actions
        .iter()
        .map(|a| TaskId(a.action_key.clone()))
        .collect();
    let edges: Vec<_> = actions
        .iter()
        .flat_map(|a| {
            a.dependency_keys
                .iter()
                .map(|pred| (TaskId(pred.clone()), TaskId(a.action_key.clone())))
        })
        .collect();
    validate_part_dag(
        &ids.iter().map(|v| v.0.clone()).collect::<Vec<_>>(),
        &edges
            .iter()
            .map(|(a, b)| (a.0.clone(), b.0.clone()))
            .collect::<Vec<_>>(),
    )?;
    let mut components = Vec::<BTreeSet<TaskId>>::new();
    for id in &ids {
        if components.iter().any(|c| c.contains(id)) {
            continue;
        }
        let mut component = BTreeSet::from([id.clone()]);
        loop {
            let before = component.len();
            for (a, b) in &edges {
                if component.contains(a) || component.contains(b) {
                    component.insert(a.clone());
                    component.insert(b.clone());
                }
            }
            if component.len() == before {
                break;
            }
        }
        components.push(component);
    }
    let mut chains = Vec::new();
    for component in components {
        let Some(chain) = flat_chain(&ids, &component, &edges)? else {
            return Ok(Layout {
                chains: None,
                edges,
            });
        };
        chains.push(chain);
    }
    Ok(Layout {
        chains: Some(chains),
        edges,
    })
}

fn flat_chain(
    ids: &[TaskId],
    component: &BTreeSet<TaskId>,
    edges: &[(TaskId, TaskId)],
) -> Result<Option<Chain>> {
    let mut remaining = component.clone();
    let mut steps = Vec::new();
    while !remaining.is_empty() {
        let tasks: Vec<_> = ids
            .iter()
            .filter(|id| {
                remaining.contains(*id)
                    && !edges.iter().any(|(a, b)| b == *id && remaining.contains(a))
            })
            .cloned()
            .collect();
        if tasks.is_empty() {
            return Err(Error::Invalid("cyclic legacy plan"));
        }
        let index = steps.len();
        for task in &tasks {
            remaining.remove(task);
        }
        steps.push(Step { index, tasks });
    }
    // Consecutive layers must have every predecessor. Edges that skip a layer
    // are redundant in this order and do not change the represented order.
    for pair in steps.windows(2) {
        for pred in &pair[0].tasks {
            for succ in &pair[1].tasks {
                if !edges.contains(&(pred.clone(), succ.clone())) {
                    return Ok(None);
                }
            }
        }
    }
    let chain = Chain { steps };
    chain.validate()?;
    Ok(Some(chain))
}
