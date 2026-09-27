//! Indexed historical reverse-membership walk; no whole-node graph scan.
//!
//! Starting at the target, each node's identity-endpoint jobs are paged in
//! index order; an applied decision that merged a loser into the node makes
//! the loser a member (when it still resolves to the target), and the loser
//! is walked in turn.

use std::collections::{HashSet, VecDeque};

use rusqlite::{Connection, OptionalExtension, params};

use crate::cognition::{
    CognitionResult,
    recall::{IdentityMembersResult, IdentityReadScope, IdentitySourceBinding},
};

use super::{super::db_error, records, resolve};

/// Index rows read per page.
const PAGE: usize = 64;

pub(super) fn select(
    db: &Connection,
    target: &str,
    scope: &IdentityReadScope,
    limit: usize,
    parse_date: &dyn Fn(&str) -> f64,
    source_current: &mut impl FnMut(&IdentitySourceBinding) -> bool,
    now_millis: &mut impl FnMut() -> i64,
) -> CognitionResult<IdentityMembersResult> {
    let mut walk = Walk {
        db,
        target,
        scope,
        limit,
        parse_date,
        source_current,
        now_millis,
        members: Vec::new(),
        member_seen: HashSet::new(),
        partial: false,
        visited_jobs: HashSet::new(),
        worklist: VecDeque::from([target.to_owned()]),
    };
    let mut visited_targets = HashSet::new();
    while walk.has_budget() {
        let Some(indexed_target) = walk.worklist.pop_front() else {
            break;
        };
        if visited_targets.insert(indexed_target.clone()) {
            walk.walk_target(&indexed_target)?;
        }
    }
    let exhausted = !walk.worklist.is_empty() && walk.members.len() >= limit;
    if (walk.now_millis)() >= scope.deadline_at || exhausted {
        walk.partial = true;
    }
    Ok(IdentityMembersResult {
        members: walk.members,
        partial: walk.partial,
    })
}

/// The walk's inputs and accumulated members.
struct Walk<'a, S, N> {
    db: &'a Connection,
    target: &'a str,
    scope: &'a IdentityReadScope,
    limit: usize,
    parse_date: &'a dyn Fn(&str) -> f64,
    source_current: &'a mut S,
    now_millis: &'a mut N,
    members: Vec<String>,
    member_seen: HashSet<String>,
    partial: bool,
    visited_jobs: HashSet<String>,
    worklist: VecDeque<String>,
}

impl<S, N> Walk<'_, S, N>
where
    S: FnMut(&IdentitySourceBinding) -> bool,
    N: FnMut() -> i64,
{
    fn has_budget(&mut self) -> bool {
        self.members.len() < self.limit && (self.now_millis)() < self.scope.deadline_at
    }

    /// The deadline passed or the member limit is reached (clock read first).
    fn spent(&mut self) -> bool {
        (self.now_millis)() >= self.scope.deadline_at || self.members.len() >= self.limit
    }

    /// Pages through the jobs indexed under `indexed_target`.
    fn walk_target(&mut self, indexed_target: &str) -> CognitionResult<()> {
        let mut after = (String::new(), String::new());
        while self.has_budget() {
            let jobs = self.job_page(indexed_target, &after)?;
            if jobs.is_empty() {
                break;
            }
            let page_len = jobs.len();
            for (relation, episode) in jobs {
                after = (episode.clone(), relation.clone());
                if self.spent() {
                    self.partial = true;
                    break;
                }
                self.visit_job(indexed_target, &relation, &episode)?;
            }
            if page_len < PAGE {
                break;
            }
        }
        Ok(())
    }

    /// The next page of `(relation, episode)` rows after `after`.
    fn job_page(
        &self,
        indexed_target: &str,
        (after_episode, after_relation): &(String, String),
    ) -> CognitionResult<Vec<(String, String)>> {
        let mut statement = self
            .db
            .prepare(
                "SELECT relation,memory_chunk_id FROM memory_chunk_graph_refs
                 WHERE graph_ref_type='identity_endpoint_job' AND graph_ref_id=?1
                   AND (memory_chunk_id>?2 OR (memory_chunk_id=?3 AND relation>?4))
                 ORDER BY memory_chunk_id,relation LIMIT 64",
            )
            .map_err(db_error)?;
        statement
            .query_map(
                params![indexed_target, after_episode, after_episode, after_relation],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)
    }

    /// Visits one job's decisions once per indexed target; a job no longer
    /// owned by the indexed episode makes the result partial.
    fn visit_job(
        &mut self,
        indexed_target: &str,
        relation: &str,
        episode: &str,
    ) -> CognitionResult<()> {
        let Some(job) = job_ref(relation) else {
            return Ok(());
        };
        if !self.visited_jobs.insert(format!("{indexed_target}\0{job}")) {
            return Ok(());
        }
        let owner = self
            .db
            .query_row(
                "SELECT episode_id FROM memory_projection_jobs WHERE job_id=?1",
                [&job],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?;
        if owner.as_deref() != Some(episode) {
            self.partial = true;
            return Ok(());
        }
        for record in records::for_job(self.db, &job)? {
            if self.spent() {
                self.partial = true;
                break;
            }
            let merged_here = record.literal_canonical.as_deref() == Some(indexed_target)
                || record.resolved_target.as_deref() == Some(indexed_target);
            if record.operation == "apply" && merged_here {
                self.admit(record.literal_loser)?;
            }
        }
        Ok(())
    }

    /// Adds a merged loser that still resolves to the target.
    fn admit(&mut self, loser: String) -> CognitionResult<()> {
        let resolved = resolve::resolve(
            self.db,
            &loser,
            self.scope,
            self.parse_date,
            self.source_current,
            self.now_millis,
        )?;
        self.partial |= resolved.partial;
        if resolved.node_id == self.target && self.member_seen.insert(loser.clone()) {
            self.members.push(loser.clone());
            self.worklist.push_back(loser);
        }
        Ok(())
    }
}

fn job_ref(relation: &str) -> Option<String> {
    let value = relation.strip_prefix("identity_job:")?;
    (value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
    .then(|| value.to_owned())
}
