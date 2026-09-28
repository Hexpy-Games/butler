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

impl Frontier {
    fn new(node: String, depth: usize, path: PathState) -> Self {
        Self {
            node,
            depth,
            path,
            adjacency: None,
            cursor: 0,
            offset: 0,
            more: true,
            identity_loaded: false,
        }
    }

    /// Whether the next adjacency page must be loaded first.
    fn needs_page(&self) -> bool {
        self.adjacency
            .as_ref()
            .is_none_or(|items| self.cursor >= items.len() && self.more)
    }
}

/// One seed's breadth-first walk: its queue, the nodes it reached, and its
/// best path to each.
struct Lane {
    queue: VecDeque<Frontier>,
    seen: HashSet<String>,
    paths: IndexMap<String, PathState>,
}

/// What following the next adjacent edge did.
enum Visit {
    /// The frontier has no edges left and is dropped.
    Exhausted,
    Followed,
    /// The edge budget ran out; the round stops.
    EdgeLimit,
}

/// The expansion adopted so far: each node's best path, the edges, and
/// the coverage codes of any limit that was hit.
#[derive(Default)]
struct Expansion {
    paths: IndexMap<String, PathState>,
    edges: IndexMap<String, RecallEdge>,
    codes: HashSet<String>,
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
    let mut expansion = Expansion::default();
    let mut lanes = seeds
        .iter()
        .enumerate()
        .map(|(seed_index, seed)| {
            let path = PathState {
                steps: Arc::new(Vec::new()),
                edge_ids: Arc::new(Vec::new()),
                seed_index,
            };
            expansion.paths.insert(seed.clone(), path.clone());
            Lane {
                queue: VecDeque::from([Frontier::new(seed.clone(), 0, path.clone())]),
                seen: HashSet::from([seed.clone()]),
                paths: IndexMap::from([(seed.clone(), path)]),
            }
        })
        .collect::<Vec<_>>();
    while lanes.iter().any(|lane| !lane.queue.is_empty()) {
        let mut progressed = false;
        for lane in &mut lanes {
            if now_millis() >= deadline_at {
                expansion.codes.insert("graph_deadline".into());
                break;
            }
            let Some(mut frontier) = lane.queue.pop_front() else {
                continue;
            };
            if !frontier.identity_loaded
                && let Some(load) = load_identity_members.as_deref_mut()
            {
                frontier.identity_loaded = true;
                expansion.adopt_identity(lane, &frontier, load)?;
            }
            if frontier.needs_page() {
                expansion.load_page(&mut frontier, &mut load_adjacency)?;
            }
            progressed = true;
            match expansion.follow_next(lane, &mut frontier) {
                Visit::Exhausted => {}
                Visit::Followed => lane.queue.push_front(frontier),
                Visit::EdgeLimit => {
                    lane.queue.push_front(frontier);
                    break;
                }
            }
        }
        if expansion.codes.contains("graph_deadline")
            || expansion.codes.contains("graph_edge_limit")
            || !progressed
        {
            break;
        }
    }
    Ok(expansion.finish(seeds))
}

impl Expansion {
    /// Adopts the frontier node's identity members at its own depth and path.
    fn adopt_identity<E>(
        &mut self,
        lane: &mut Lane,
        frontier: &Frontier,
        load: &mut IdentityMembersLoader<'_, E>,
    ) -> Result<(), E> {
        let remaining = MAX_NODES.saturating_sub(self.paths.len());
        let identity = load(&frontier.node, remaining)?;
        if identity.partial {
            self.codes.insert("identity_partial".into());
        }
        for member in identity.members {
            if self.paths.contains_key(&member) {
                continue;
            }
            if self.paths.len() >= MAX_NODES {
                self.codes.insert("graph_node_limit".into());
                break;
            }
            self.paths.insert(member.clone(), frontier.path.clone());
            lane.paths.insert(member.clone(), frontier.path.clone());
            lane.seen.insert(member.clone());
            lane.queue
                .push_back(Frontier::new(member, frontier.depth, frontier.path.clone()));
        }
        Ok(())
    }

    /// Loads the frontier's next adjacency page, bounded by the edge budget.
    fn load_page<E>(
        &self,
        frontier: &mut Frontier,
        load_adjacency: &mut impl FnMut(&str, usize, usize) -> Result<EligibleAdjacency, E>,
    ) -> Result<(), E> {
        let page_size = 256.min(MAX_EDGES.saturating_sub(self.edges.len()).max(1));
        let page = load_adjacency(&frontier.node, page_size, frontier.offset)?;
        frontier.offset += page.edges.len();
        frontier.adjacency = Some(sort_adjacency(&frontier.node, page.edges));
        frontier.cursor = 0;
        frontier.more = page.truncated;
        Ok(())
    }

    /// Follows the frontier's next adjacent edge within the depth, node and
    /// edge limits.
    fn follow_next(&mut self, lane: &mut Lane, frontier: &mut Frontier) -> Visit {
        let index = frontier.cursor;
        frontier.cursor += 1;
        let frontier = &*frontier;
        let Some(adjacent) = frontier
            .adjacency
            .as_ref()
            .and_then(|items| items.get(index))
        else {
            return Visit::Exhausted;
        };
        let existing = self.paths.get(&adjacent.neighbor).cloned();
        let edge_known = self.edges.contains_key(&adjacent.edge.edge_id);
        if frontier.depth >= MAX_DEPTH && existing.is_none() {
            if !edge_known {
                self.codes.insert("graph_depth_limit".into());
            }
            return Visit::Followed;
        }
        if existing.is_none() && self.paths.len() >= MAX_NODES {
            self.codes.insert("graph_node_limit".into());
            return Visit::Followed;
        }
        if !edge_known {
            if self.edges.len() >= MAX_EDGES {
                self.codes.insert("graph_edge_limit".into());
                return Visit::EdgeLimit;
            }
            self.edges
                .insert(adjacent.edge.edge_id.clone(), adjacent.edge.clone());
        }
        if frontier.depth < MAX_DEPTH {
            self.extend_path(lane, frontier, adjacent, existing.as_ref());
        }
        Visit::Followed
    }

    /// Offers the path through `adjacent` as the neighbor's best path,
    /// globally and for this seed, and queues the neighbor once per seed.
    fn extend_path(
        &mut self,
        lane: &mut Lane,
        frontier: &Frontier,
        adjacent: &Adjacent,
        existing: Option<&PathState>,
    ) {
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
        let shorter = |prior: &PathState| compare_paths(&candidate, prior).is_lt();
        if existing.is_none_or(shorter) {
            self.paths
                .insert(adjacent.neighbor.clone(), candidate.clone());
        }
        if lane.paths.get(&adjacent.neighbor).is_none_or(shorter) {
            lane.paths
                .insert(adjacent.neighbor.clone(), candidate.clone());
            if let Some(queued) = lane
                .queue
                .iter_mut()
                .find(|item| item.node == adjacent.neighbor)
                && queued.adjacency.is_none()
            {
                queued.path = candidate.clone();
            }
        }
        if lane.seen.insert(adjacent.neighbor.clone()) {
            lane.queue.push_back(Frontier::new(
                adjacent.neighbor.clone(),
                frontier.depth + 1,
                candidate,
            ));
        }
    }

    fn finish(self, seeds: &[String]) -> GraphExpansion {
        let nodes = self.paths.keys().cloned().collect::<Vec<_>>();
        let edges = self.edges.into_values().collect::<Vec<_>>();
        let relevance = ppr::personalized_page_rank(&nodes, seeds, &edges);
        let paths = self
            .paths
            .into_iter()
            .map(|(node, path)| (node, path.steps.as_ref().clone()))
            .collect();
        let mut coverage_codes = self.codes.into_iter().collect::<Vec<_>>();
        coverage_codes.sort();
        GraphExpansion {
            relevance,
            paths,
            #[cfg(test)]
            edges,
            coverage_codes,
        }
    }
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
