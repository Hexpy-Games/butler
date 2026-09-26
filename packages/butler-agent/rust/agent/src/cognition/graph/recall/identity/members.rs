//! Indexed historical reverse-membership walk; no whole-node graph scan.

use std::collections::{HashSet, VecDeque};

use rusqlite::{Connection, OptionalExtension, params};

use crate::cognition::{
    CognitionResult,
    recall::{IdentityMembersResult, IdentityReadScope, IdentitySourceBinding},
};

use super::{super::db_error, records, resolve};

pub(super) fn select(
    db: &Connection,
    target: &str,
    scope: &IdentityReadScope,
    limit: usize,
    parse_date: &dyn Fn(&str) -> f64,
    source_current: &mut impl FnMut(&IdentitySourceBinding) -> bool,
    now_millis: &mut impl FnMut() -> i64,
) -> CognitionResult<IdentityMembersResult> {
    let mut members = Vec::new();
    let mut member_seen = HashSet::new();
    let mut partial = false;
    let mut visited_jobs = HashSet::new();
    let mut worklist = VecDeque::from([target.to_owned()]);
    let mut visited_targets = HashSet::new();
    while members.len() < limit && now_millis() < scope.deadline_at {
        let Some(indexed_target) = worklist.pop_front() else {
            break;
        };
        if !visited_targets.insert(indexed_target.clone()) {
            continue;
        }
        let mut after_episode = String::new();
        let mut after_relation = String::new();
        while members.len() < limit && now_millis() < scope.deadline_at {
            let mut statement = db
                .prepare(
                    "SELECT relation,memory_chunk_id FROM memory_chunk_graph_refs
                 WHERE graph_ref_type='identity_endpoint_job' AND graph_ref_id=?1
                   AND (memory_chunk_id>?2 OR (memory_chunk_id=?3 AND relation>?4))
                 ORDER BY memory_chunk_id,relation LIMIT 64",
                )
                .map_err(db_error)?;
            let jobs = statement
                .query_map(
                    params![indexed_target, after_episode, after_episode, after_relation],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?;
            if jobs.is_empty() {
                break;
            }
            let page_len = jobs.len();
            for (relation, episode) in jobs {
                after_episode = episode.clone();
                after_relation = relation.clone();
                if now_millis() >= scope.deadline_at || members.len() >= limit {
                    partial = true;
                    break;
                }
                let Some(job) = job_ref(&relation) else {
                    continue;
                };
                if !visited_jobs.insert(format!("{indexed_target}\0{job}")) {
                    continue;
                }
                let owner = db
                    .query_row(
                        "SELECT episode_id FROM memory_projection_jobs WHERE job_id=?1",
                        [&job],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(db_error)?;
                if owner.as_deref() != Some(episode.as_str()) {
                    partial = true;
                    continue;
                }
                for record in records::for_job(db, &job)? {
                    if now_millis() >= scope.deadline_at || members.len() >= limit {
                        partial = true;
                        break;
                    }
                    if record.operation != "apply"
                        || (record.literal_canonical.as_deref() != Some(&indexed_target)
                            && record.resolved_target.as_deref() != Some(&indexed_target))
                    {
                        continue;
                    }
                    let resolved = resolve::resolve(
                        db,
                        &record.literal_loser,
                        scope,
                        parse_date,
                        source_current,
                        now_millis,
                    )?;
                    partial |= resolved.partial;
                    if resolved.node_id == target
                        && member_seen.insert(record.literal_loser.clone())
                    {
                        members.push(record.literal_loser.clone());
                        worklist.push_back(record.literal_loser);
                    }
                }
            }
            if page_len < 64 {
                break;
            }
        }
    }
    if now_millis() >= scope.deadline_at || (!worklist.is_empty() && members.len() >= limit) {
        partial = true;
    }
    Ok(IdentityMembersResult { members, partial })
}

fn job_ref(relation: &str) -> Option<String> {
    let value = relation.strip_prefix("identity_job:")?;
    (value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
    .then(|| value.to_owned())
}
