//! Source-ordered bounded recall graph expansion over a caller-owned read lane.

mod ppr;

use std::{collections::HashSet, collections::VecDeque, sync::Arc};

use indexmap::IndexMap;

use super::contracts::{
    EligibleAdjacency, GraphExpansion, IdentityMembers, RecallAssociationStep, RecallEdge,
};

const MAX_DEPTH: usize = 3;
const MAX_NODES: usize = 2_000;
const MAX_EDGES: usize = 8_000;

#[derive(Clone)]
struct PathState {
    steps: Arc<Vec<RecallAssociationStep>>,
    edge_ids: Arc<Vec<String>>,
    seed_index: usize,
}

struct Adjacent {
    edge: RecallEdge,
    neighbor: String,
    reverse: bool,
}

struct Frontier {
    node: String,
    depth: usize,
    path: PathState,
    adjacency: Option<Vec<Adjacent>>,
    cursor: usize,
    offset: usize,
    more: bool,
    identity_loaded: bool,
}

type IdentityMembersLoader<'a, E> = dyn FnMut(&str, usize) -> Result<IdentityMembers, E> + 'a;

/// Callbacks run synchronously on the future pinned graph read owner. Errors
/// propagate without a replacement result or an invented coverage code.
pub(in crate::cognition) fn expand_graph<E>(
    seeds: &[String],
    mut load_adjacency: impl FnMut(&str, usize, usize) -> Result<EligibleAdjacency, E>,
    deadline_at: i64,
    mut now_millis: impl FnMut() -> i64,
    mut load_identity_members: Option<&mut IdentityMembersLoader<'_, E>>,
) -> Result<GraphExpansion, E> {
    let mut adopted_paths = IndexMap::<String, PathState>::new();
    let mut queues = Vec::with_capacity(seeds.len());
    let mut local_seen = Vec::with_capacity(seeds.len());
    let mut local_paths = Vec::with_capacity(seeds.len());
    for (seed_index, seed) in seeds.iter().enumerate() {
        let path = PathState {
            steps: Arc::new(Vec::new()),
            edge_ids: Arc::new(Vec::new()),
            seed_index,
        };
        adopted_paths.insert(seed.clone(), path.clone());
        queues.push(VecDeque::from([Frontier {
            node: seed.clone(),
            depth: 0,
            path: path.clone(),
            adjacency: None,
            cursor: 0,
            offset: 0,
            more: true,
            identity_loaded: false,
        }]));
        local_seen.push(HashSet::from([seed.clone()]));
        local_paths.push(IndexMap::from([(seed.clone(), path)]));
    }
    let mut adopted = IndexMap::<String, RecallEdge>::new();
    let mut codes = HashSet::<String>::new();
    while queues.iter().any(|queue| !queue.is_empty()) {
        let mut progressed = false;
        for seed_index in 0..queues.len() {
            if now_millis() >= deadline_at {
                codes.insert("graph_deadline".into());
                break;
            }
            let queue = &mut queues[seed_index];
            let Some(mut frontier) = queue.pop_front() else {
                continue;
            };
            if !frontier.identity_loaded
                && let Some(load) = load_identity_members.as_deref_mut()
            {
                frontier.identity_loaded = true;
                let remaining = MAX_NODES.saturating_sub(adopted_paths.len());
                let identity = load(&frontier.node, remaining)?;
                if identity.partial {
                    codes.insert("identity_partial".into());
                }
                for member in identity.members {
                    if adopted_paths.contains_key(&member) {
                        continue;
                    }
                    if adopted_paths.len() >= MAX_NODES {
                        codes.insert("graph_node_limit".into());
                        break;
                    }
                    adopted_paths.insert(member.clone(), frontier.path.clone());
                    local_paths[seed_index].insert(member.clone(), frontier.path.clone());
                    local_seen[seed_index].insert(member.clone());
                    queue.push_back(Frontier {
                        node: member,
                        depth: frontier.depth,
                        path: frontier.path.clone(),
                        adjacency: None,
                        cursor: 0,
                        offset: 0,
                        more: true,
                        identity_loaded: false,
                    });
                }
            }
            if frontier.adjacency.is_none()
                || frontier
                    .adjacency
                    .as_ref()
                    .is_some_and(|items| frontier.cursor >= items.len() && frontier.more)
            {
                let page_size = 256.min((MAX_EDGES - adopted.len()).max(1));
                let page = load_adjacency(&frontier.node, page_size, frontier.offset)?;
                frontier.offset += page.edges.len();
                frontier.adjacency = Some(sort_adjacency(&frontier.node, page.edges));
                frontier.cursor = 0;
                frontier.more = page.truncated;
            }
            let adjacent = frontier
                .adjacency
                .as_ref()
                .and_then(|items| items.get(frontier.cursor));
            frontier.cursor += 1;
            let Some(adjacent) = adjacent else {
                progressed = true;
                continue;
            };
            progressed = true;
            let existing = adopted_paths.get(&adjacent.neighbor).cloned();
            let edge_known = adopted.contains_key(&adjacent.edge.edge_id);
            let mut edge_limit = false;
            if frontier.depth >= MAX_DEPTH && existing.is_none() {
                if !edge_known {
                    codes.insert("graph_depth_limit".into());
                }
            } else if existing.is_none() && adopted_paths.len() >= MAX_NODES {
                codes.insert("graph_node_limit".into());
            } else {
                if !edge_known {
                    if adopted.len() >= MAX_EDGES {
                        codes.insert("graph_edge_limit".into());
                        edge_limit = true;
                    } else {
                        adopted.insert(adjacent.edge.edge_id.clone(), adjacent.edge.clone());
                    }
                }
                if !edge_limit && frontier.depth < MAX_DEPTH {
                    let mut steps = frontier.path.steps.as_ref().clone();
                    steps.push(RecallAssociationStep {
                        from: adjacent.edge.source_node_id.clone(),
                        relation: adjacent.edge.relation.clone(),
                        to: adjacent.edge.target_node_id.clone(),
                        traversed_reverse: adjacent.reverse,
                    });
                    let mut edge_ids = frontier.path.edge_ids.as_ref().clone();
                    edge_ids.push(adjacent.edge.edge_id.clone());
                    let candidate = PathState {
                        steps: Arc::new(steps),
                        edge_ids: Arc::new(edge_ids),
                        seed_index: frontier.path.seed_index,
                    };
                    if existing
                        .as_ref()
                        .is_none_or(|prior| compare_paths(&candidate, prior).is_lt())
                    {
                        adopted_paths.insert(adjacent.neighbor.clone(), candidate.clone());
                    }
                    if local_paths[seed_index]
                        .get(&adjacent.neighbor)
                        .is_none_or(|prior| compare_paths(&candidate, prior).is_lt())
                    {
                        local_paths[seed_index]
                            .insert(adjacent.neighbor.clone(), candidate.clone());
                        if let Some(queued) =
                            queue.iter_mut().find(|item| item.node == adjacent.neighbor)
                            && queued.adjacency.is_none()
                        {
                            queued.path = candidate.clone();
                        }
                    }
                    if local_seen[seed_index].insert(adjacent.neighbor.clone()) {
                        queue.push_back(Frontier {
                            node: adjacent.neighbor.clone(),
                            depth: frontier.depth + 1,
                            path: candidate,
                            adjacency: None,
                            cursor: 0,
                            offset: 0,
                            more: true,
                            identity_loaded: false,
                        });
                    }
                }
            }
            queue.push_front(frontier);
            if edge_limit {
                break;
            }
        }
        if codes.contains("graph_deadline") || codes.contains("graph_edge_limit") || !progressed {
            break;
        }
    }
    let nodes = adopted_paths.keys().cloned().collect::<Vec<_>>();
    let edges = adopted.into_values().collect::<Vec<_>>();
    let relevance = ppr::personalized_page_rank(&nodes, seeds, &edges);
    let paths = adopted_paths
        .into_iter()
        .map(|(node, path)| (node, path.steps.as_ref().clone()))
        .collect();
    let mut coverage_codes = codes.into_iter().collect::<Vec<_>>();
    coverage_codes.sort();
    Ok(GraphExpansion {
        relevance,
        paths,
        #[cfg(test)]
        edges,
        coverage_codes,
    })
}

fn compare_paths(a: &PathState, b: &PathState) -> std::cmp::Ordering {
    a.steps
        .len()
        .cmp(&b.steps.len())
        .then(a.seed_index.cmp(&b.seed_index))
        .then_with(|| {
            a.edge_ids
                .iter()
                .map(String::as_bytes)
                .cmp(b.edge_ids.iter().map(String::as_bytes))
        })
}

fn sort_adjacency(node: &str, edges: Vec<RecallEdge>) -> Vec<Adjacent> {
    let mut adjacent = edges
        .into_iter()
        .filter(|edge| is_positive(&edge.relation))
        .map(|edge| {
            let (neighbor, reverse) = if edge.source_node_id == node {
                (edge.target_node_id.clone(), false)
            } else {
                (edge.source_node_id.clone(), true)
            };
            Adjacent {
                edge,
                neighbor,
                reverse,
            }
        })
        .collect::<Vec<_>>();
    adjacent.sort_by(|a, b| {
        is_navigation(&a.edge.relation)
            .cmp(&is_navigation(&b.edge.relation))
            .then_with(|| {
                let delta = b.edge.support - a.edge.support;
                if delta < 0.0 {
                    std::cmp::Ordering::Less
                } else if delta > 0.0 {
                    std::cmp::Ordering::Greater
                } else {
                    std::cmp::Ordering::Equal
                }
            })
            .then(a.edge.relation.as_bytes().cmp(b.edge.relation.as_bytes()))
            .then(a.neighbor.as_bytes().cmp(b.neighbor.as_bytes()))
            .then(a.edge.edge_id.as_bytes().cmp(b.edge.edge_id.as_bytes()))
    });
    adjacent
}

fn is_navigation(relation: &str) -> bool {
    matches!(
        relation,
        "belongs_to" | "co_occurred" | "identity_match" | "same_claim"
    )
}

fn is_positive(relation: &str) -> bool {
    matches!(
        relation,
        "related_to"
            | "depends_on"
            | "likes"
            | "dislikes"
            | "decided"
            | "has_subject"
            | "has_object"
            | "condition_member"
            | "belongs_to"
            | "co_occurred"
            | "identity_match"
            | "same_claim"
    )
}
