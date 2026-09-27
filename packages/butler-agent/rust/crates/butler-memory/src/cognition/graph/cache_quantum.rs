//! Candidate-generation cache claim, current evidence, and durable receipt transitions.

use crate::cognition::CognitionCode;
use crate::cognition::graph::StageWrite;
use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, de::IgnoredAny};
use serde_json::json;

use super::{
    GraphRepository, apply::context::resolve_quotes, db_error, plan::validate_quotes_for_apply,
};
use crate::cognition::generation::cache::receipt::{
    CacheJobReceipt, EntryOutcome, ExclusionReason,
};
use crate::cognition::generation::cache::{
    Authority, Salience, Scope, SourceBackedHotCacheEntry, SourceClass, SourceKind,
};
use crate::cognition::{
    CognitionError, CognitionResult,
    extraction::{ExtractInput, ExtractOutput},
    sources::projection_hash_for_graph,
};

#[derive(Clone, Debug)]
pub(in crate::cognition) struct ClaimedCacheJob {
    pub job_id: String,
    pub episode_id: String,
    pub revision: String,
    pub generation: String,
    pub summary: String,
    pub summary_status: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub source_time: String,
    pub source_key: String,
    pub source_hash: String,
    pub extraction_version: String,
    pub source_kind: String,
    pub owner_nonce: String,
    pub attempt: i64,
}

/// One window summary ready to be written to the cache.
#[derive(Clone, Debug)]
pub(in crate::cognition) struct CacheWindow {
    pub entry_id: String,
    pub entry: SourceBackedHotCacheEntry,
}

impl GraphRepository {
    pub(in crate::cognition) fn valid_cache_entry_ids(
        &self,
        generation: &str,
    ) -> CognitionResult<HashSet<String>> {
        let mut query=self.connection()?.prepare("SELECT o.entry_id FROM memory_hot_cache_outcomes o JOIN memory_projection_jobs j ON j.generation=o.generation JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE o.generation=?1 AND o.admitted=1 AND json_extract(j.hot_cache_state,'$.state')='complete' AND EXISTS (SELECT 1 FROM json_each(j.hot_cache_receipt_json,'$.entries') e WHERE json_extract(e.value,'$.source_id')=o.entry_id) ORDER BY o.entry_id").map_err(db_error)?;
        let rows = query
            .query_map([generation], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<HashSet<_>, _>>()
            .map_err(db_error)?;
        Ok(rows)
    }

    pub(in crate::cognition) fn claim_cache_job(
        &mut self,
        now: &str,
    ) -> CognitionResult<Option<ClaimedCacheJob>> {
        let connection = self.connection_mut()?;
        recover(connection)?;
        let tx = connection.transaction().map_err(db_error)?;
        let selected = tx.query_row(
            "SELECT j.job_id,j.episode_id,j.revision,j.generation,c.summary,c.summary_status,c.project_id,
                    c.conversation_session_id,COALESCE(c.conversation_start,c.created_at),c.source_key,c.source_hash,
                    j.extraction_version,COALESCE((SELECT s.source_kind FROM memory_chunk_sources s WHERE s.episode_id=j.episode_id AND s.revision=j.revision ORDER BY s.source_id LIMIT 1),''),j.hot_cache_attempt_count
             FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
             WHERE json_extract(j.hot_cache_state,'$.state')='pending' AND (c.summary_status='complete'
                    OR json_extract(j.semantic_graph_state,'$.state') IN ('complete','failed')
                    OR (json_extract(j.semantic_graph_state,'$.state')='partial' AND COALESCE(json_extract(j.semantic_graph_state,'$.pending_units'),0)=0))
                    AND (j.hot_cache_next_attempt_at IS NULL OR j.hot_cache_next_attempt_at<=?1)
             ORDER BY j.last_served_at IS NOT NULL,j.last_served_at,j.created_at,j.job_id LIMIT 1",
            [now],
            |row| Ok(ClaimedCacheJob {
                job_id:row.get(0)?,episode_id:row.get(1)?,revision:row.get(2)?,generation:row.get(3)?,
                summary:row.get(4)?,summary_status:row.get(5)?,project_id:row.get(6)?,session_id:row.get(7)?,
                source_time:row.get(8)?,source_key:row.get(9)?,source_hash:row.get(10)?,
                extraction_version:row.get(11)?,source_kind:row.get(12)?,owner_nonce:String::new(),attempt:row.get(13)?,
            }),
        ).optional().map_err(db_error)?;
        let Some(mut job) = selected else {
            tx.commit().map_err(db_error)?;
            return Ok(None);
        };
        job.owner_nonce = uuid::Uuid::new_v4().to_string();
        job.attempt += 1;
        let changed = tx.execute("UPDATE memory_projection_jobs SET hot_cache_attempt_count=?1,hot_cache_owner_pid=?2,hot_cache_owner_nonce=?3,hot_cache_started_at=?4,hot_cache_state=?5 WHERE job_id=?6 AND json_extract(hot_cache_state,'$.state')='pending'",
            params![job.attempt,i64::from(std::process::id()),job.owner_nonce,now,StageWrite::Running { attempt: job.attempt, owner_pid: std::process::id(), started_at: now.to_owned() }.json(),job.job_id]).map_err(db_error)?;
        if changed != 1 {
            return Err(error(CognitionCode::MemoryCacheJobChanged));
        }
        tx.commit().map_err(db_error)?;
        Ok(Some(job))
    }

    pub(in crate::cognition) fn assert_cache_job_current(
        &self,
        job: &ClaimedCacheJob,
    ) -> CognitionResult<()> {
        let exists = self.connection()?.query_row("SELECT 1 FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE j.job_id=?1 AND j.revision=?2 AND j.generation=?3 AND j.hot_cache_owner_nonce=?4 AND json_extract(j.hot_cache_state,'$.state')='running'",
            params![job.job_id,job.revision,job.generation,job.owner_nonce], |_| Ok(())).optional().map_err(db_error)?;
        exists.ok_or_else(|| error(CognitionCode::MemorySourceChanged))
    }

    /// One cache entry per completed window with a non-empty summary, built
    /// from its stored input, output, and resolved plan.
    pub(in crate::cognition) fn cache_windows(
        &self,
        job: &ClaimedCacheJob,
    ) -> CognitionResult<Vec<CacheWindow>> {
        self.assert_cache_job_current(job)?;
        let connection = self.connection()?;
        let graph_revision = connection
            .query_row(
                "SELECT value FROM memory_state WHERE key='graph_revision'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?
            .unwrap_or_else(|| "0".into())
            .parse::<i64>()
            .map_err(|source| error(CognitionCode::HotCacheEvidenceInvalid).with_source(source))?;
        let mut query = connection.prepare("SELECT window_ref,input_json,output_json,normalized_plan_json FROM memory_projection_windows WHERE job_id=?1 AND state='complete' ORDER BY ordinal,window_ref").map_err(db_error)?;
        let stored = query
            .query_map([&job.job_id], |row| {
                Ok(StoredWindow {
                    window_ref: row.get(0)?,
                    input_json: row.get(1)?,
                    output_json: row.get(2)?,
                    plan_json: row.get(3)?,
                })
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        let mut windows = Vec::new();
        for window in stored {
            if let Some(entry) = window_entry(connection, job, graph_revision, &window)? {
                windows.push(entry);
            }
        }
        Ok(windows)
    }

    pub(in crate::cognition) fn complete_cache_job(
        &mut self,
        job: &ClaimedCacheJob,
        receipt: &CacheJobReceipt,
        outcomes: &[EntryOutcome],
    ) -> CognitionResult<()> {
        self.assert_cache_job_current(job)?;
        let tx = self.connection_mut()?.transaction().map_err(db_error)?;
        for outcome in outcomes {
            tx.execute("INSERT INTO memory_hot_cache_outcomes(entry_id,generation,admitted,reason,receipt_json) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(entry_id) DO UPDATE SET generation=excluded.generation,admitted=excluded.admitted,reason=excluded.reason,receipt_json=excluded.receipt_json",
                params![outcome.entry_id,job.generation,i64::from(outcome.admitted),outcome.reason.map(ExclusionReason::as_str),to_json(&outcome.receipt)?]).map_err(db_error)?;
        }
        if tx.execute("UPDATE memory_projection_jobs SET hot_cache_state=?1,hot_cache_receipt_json=?2,hot_cache_next_attempt_at=NULL,hot_cache_owner_pid=NULL,hot_cache_owner_nonce=NULL,hot_cache_started_at=NULL WHERE job_id=?3 AND hot_cache_owner_nonce=?4 AND json_extract(hot_cache_state,'$.state')='running'",
            params![StageWrite::complete(1).json(),to_json(receipt)?,job.job_id,job.owner_nonce]).map_err(db_error)? != 1 { return Err(error(CognitionCode::MemoryCacheJobChanged)); }
        tx.commit().map_err(db_error)
    }

    pub(in crate::cognition) fn fail_cache_job(
        &mut self,
        job: &ClaimedCacheJob,
        code: &str,
    ) -> CognitionResult<()> {
        self.assert_cache_job_current(job)?;
        let retry = job.attempt < 3;
        let retry_at = retry.then(|| {
            (chrono::Utc::now()
                + chrono::Duration::seconds(if job.attempt == 1 { 30 } else { 120 }))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        });
        self.connection_mut()?.execute("UPDATE memory_projection_jobs SET hot_cache_state=?1,hot_cache_receipt_json=?2,hot_cache_next_attempt_at=?3,hot_cache_owner_pid=NULL,hot_cache_owner_nonce=NULL,hot_cache_started_at=NULL WHERE job_id=?4 AND hot_cache_owner_nonce=?5",
            params![if retry {StageWrite::blocked(code)} else {StageWrite::failed(code)}.json(),json!({"outcome":"failed","code":code,"retry_at":retry_at}).to_string(),retry_at,job.job_id,job.owner_nonce]).map_err(db_error)?;
        Ok(())
    }
}

/// A completed projection window as stored.
struct StoredWindow {
    window_ref: String,
    input_json: Option<String>,
    output_json: Option<String>,
    plan_json: Option<String>,
}

/// The stored plan's `refs`: local refs resolved to graph node ids.
#[derive(Deserialize)]
struct StoredPlan {
    refs: HashMap<String, PlanRef>,
}

/// A plan ref is a node id; any other value is not a node.
#[derive(Deserialize)]
#[serde(untagged)]
enum PlanRef {
    Node(String),
    Other(IgnoredAny),
}

/// Where a window summary's quoted sources came from.
struct QuotedSources {
    source_refs: Vec<String>,
    bases: Vec<String>,
    class: SourceClass,
}

/// The cache entry for one window, or `None` when it has no summary.
fn window_entry(
    connection: &Connection,
    job: &ClaimedCacheJob,
    graph_revision: i64,
    window: &StoredWindow,
) -> CognitionResult<Option<CacheWindow>> {
    let output: ExtractOutput = parse_evidence(window.output_json.as_deref())?;
    let Some(summary) = output
        .summary
        .as_ref()
        .filter(|value| !value.text.trim().is_empty())
    else {
        return Ok(None);
    };
    let input: ExtractInput = parse_evidence(window.input_json.as_deref())?;
    let plan: StoredPlan = parse_evidence(window.plan_json.as_deref())?;
    let quoted = quoted_sources(connection, job, &input, &summary.evidence)?;
    let body = summary.text.trim().to_owned();
    let entry_id = projection_hash_for_graph(vec![
        json!("hot-cache-window-summary"),
        json!(job.generation),
        json!(job.episode_id),
        json!(window.window_ref),
        json!(job.revision),
        json!(body),
    ])?;
    let mut node_refs = plan
        .refs
        .into_values()
        .filter_map(|reference| match reference {
            PlanRef::Node(id) => Some(id),
            PlanRef::Other(_) => None,
        })
        .collect::<Vec<_>>();
    node_refs.sort();
    node_refs.dedup();
    let entry = SourceBackedHotCacheEntry {
        entry_id: entry_id.clone(),
        episode_id: job.episode_id.clone(),
        window_ref: window.window_ref.clone(),
        node_refs,
        source_revision: job.revision.clone(),
        source_time: job.source_time.clone(),
        valid_until: output
            .claims
            .iter()
            .filter_map(|claim| claim.valid_to.clone())
            .min(),
        kind: window_kind(&output),
        summary: body,
        basis: quoted.bases,
        salience: window_salience(&output),
        scope: if job.project_id.is_some() {
            Scope::Project
        } else {
            Scope::Global
        },
        project_id: job.project_id.clone(),
        session_id: job.session_id.clone(),
        source_kind: Some(
            SourceKind::parse(&job.source_kind)
                .ok_or_else(|| error(CognitionCode::HotCacheEntryInvalid))?,
        ),
        graph_revision,
        authority: Some(Authority::ModelInterpretation),
        source_class: Some(quoted.class),
        source_refs: quoted.source_refs,
    };
    Ok(Some(CacheWindow { entry_id, entry }))
}

fn parse_evidence<T: serde::de::DeserializeOwned>(json: Option<&str>) -> CognitionResult<T> {
    serde_json::from_str(json.ok_or_else(|| error(CognitionCode::HotCacheEvidenceInvalid))?)
        .map_err(|source| error(CognitionCode::HotCacheEvidenceInvalid).with_source(source))
}

/// Resolves the summary's quotes to distinct source leaves of this generation.
fn quoted_sources(
    connection: &Connection,
    job: &ClaimedCacheJob,
    input: &ExtractInput,
    evidence: &[crate::cognition::extraction::QuoteRef],
) -> CognitionResult<QuotedSources> {
    let invalid = |source| error(CognitionCode::HotCacheEvidenceInvalid).with_source(source);
    let validated = validate_quotes_for_apply(input, evidence).map_err(invalid)?;
    let resolved = resolve_quotes(connection, input, &validated).map_err(invalid)?;
    let mut source_refs = Vec::new();
    let mut bases = Vec::new();
    let mut classes = Vec::new();
    let mut seen = HashSet::new();
    for quote in resolved {
        if !seen.insert(quote.source_id.clone()) {
            continue;
        }
        let (basis, role, source_kind, origin_kind) = connection.query_row("SELECT s.basis,s.role,s.source_kind,s.origin_kind FROM memory_source_leaves s JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision JOIN memory_projection_jobs j ON j.episode_id=s.episode_id AND j.revision=s.revision WHERE s.source_id=?1 AND j.generation=?2 LIMIT 1",
            params![quote.source_id,job.generation], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?)))
            .optional().map_err(db_error)?.ok_or_else(|| error(CognitionCode::HotCacheEvidenceInvalid))?;
        bases.push(basis);
        classes.push(match source_kind.as_str() {
            "task_report" => SourceClass::TaskReport,
            "explicit_record" => SourceClass::Explicit,
            _ if role == "user" && origin_kind == "user_input" => SourceClass::User,
            _ if role == "assistant" && origin_kind == "assistant_public" => SourceClass::Assistant,
            _ => SourceClass::Unknown,
        });
        source_refs.push(quote.source_id);
    }
    let Some(first) = classes.first().copied() else {
        return Err(error(CognitionCode::HotCacheEvidenceInvalid));
    };
    bases.sort();
    bases.dedup();
    Ok(QuotedSources {
        source_refs,
        bases,
        class: if classes.iter().all(|class| *class == first) {
            first
        } else {
            SourceClass::Mixed
        },
    })
}

/// The distinct claim types joined with `+`, or `window_summary`.
fn window_kind(output: &ExtractOutput) -> String {
    let mut kinds: Vec<&str> = Vec::new();
    for claim in &output.claims {
        if !claim.claim_type.is_empty() && !kinds.contains(&claim.claim_type.as_str()) {
            kinds.push(&claim.claim_type);
        }
    }
    if kinds.is_empty() {
        "window_summary".to_owned()
    } else {
        kinds.join("+")
    }
}

/// The highest salience of any claim.
fn window_salience(output: &ExtractOutput) -> Salience {
    let any = |level: &str| output.claims.iter().any(|claim| claim.salience == level);
    if any("high") {
        Salience::High
    } else if any("normal") {
        Salience::Normal
    } else {
        Salience::Unspecified
    }
}

fn to_json(value: &impl serde::Serialize) -> CognitionResult<String> {
    serde_json::to_string(value)
        .map_err(|source| error(CognitionCode::MemoryCacheOperationFailed).with_source(source))
}

fn recover(connection: &Connection) -> CognitionResult<()> {
    let mut statement=connection.prepare("SELECT job_id,hot_cache_owner_pid FROM memory_projection_jobs WHERE json_extract(hot_cache_state,'$.state')='running'").map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(statement);
    for (job, pid) in rows {
        let abandoned =
            pid.is_none_or(|pid| pid == i64::from(std::process::id()) || !pid_alive(pid));
        if abandoned {
            connection.execute("UPDATE memory_projection_jobs SET hot_cache_state=?1,hot_cache_attempt_count=MAX(0,hot_cache_attempt_count-1),hot_cache_owner_pid=NULL,hot_cache_owner_nonce=NULL,hot_cache_started_at=NULL WHERE job_id=?2",
            params![StageWrite::pending().json(),job]).map_err(db_error)?;
        }
    }
    Ok(())
}
fn pid_alive(pid: i64) -> bool {
    let Ok(raw) = i32::try_from(pid) else {
        return false;
    };
    if raw <= 0 {
        return false;
    }
    matches!(
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(raw), None),
        Ok(()) | Err(nix::errno::Errno::EPERM)
    )
}
fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
