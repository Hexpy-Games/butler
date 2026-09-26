use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::collections::HashSet;
use unicode_normalization::UnicodeNormalization;

use super::{error, stringify};
use crate::cognition::{
    CognitionResult,
    extraction::{ExtractClaim, ExtractInput, ExtractOutput, NodeResolution},
    graph::{db_error, plan::ValidatedQuote},
    lexical,
};

#[derive(Clone, Copy)]
pub(super) struct NodeUpsert<'a> {
    pub id: &'a str,
    pub node_type: &'a str,
    pub label: &'a str,
    pub resolution: &'a NodeResolution,
    pub input: &'a ExtractInput,
    pub window: &'a str,
    pub now: &'a str,
    pub evidence: Option<&'a Vec<ValidatedQuote>>,
}

pub(super) fn upsert_node(tx: &Connection, node: NodeUpsert<'_>) -> CognitionResult<()> {
    let NodeUpsert {
        id,
        node_type,
        label,
        resolution,
        input,
        window,
        now,
        evidence,
    } = node;
    let scope = match resolution {
        NodeResolution::Create { identity_scope, .. } => identity_scope.as_str(),
        NodeResolution::Reuse { .. } => {
            if input.bound_project_id.is_some() {
                "project"
            } else {
                "user"
            }
        }
    };
    tx.execute("INSERT OR IGNORE INTO memory_nodes(id,type,label_original,identity_scope,project_id,created_at,window_ref) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,node_type,label,scope,if scope=="project"{input.bound_project_id.as_deref()}else{None},now,window]).map_err(db_error)?;
    for quote in evidence.into_iter().flatten() {
        tx.execute("INSERT OR IGNORE INTO memory_evidence(node_id,source_id,episode_id,revision) SELECT ?1,source_id,episode_id,revision FROM memory_chunk_sources WHERE source_id=?2",params![id,quote.source_id]).map_err(db_error)?;
    }
    Ok(())
}

pub(super) fn insert_alias(
    tx: &Connection,
    node: &str,
    surface: &str,
    source: &str,
    kind: &str,
) -> CognitionResult<()> {
    let nfc = surface.nfc().collect::<String>();
    let folded = lexical::case_fold(&nfc);
    tx.execute("INSERT OR IGNORE INTO memory_aliases(node_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES(?1,?2,?3,?4,?5,?6)",params![node,surface,nfc,folded,source,kind]).map_err(db_error)?;
    Ok(())
}

pub(super) fn insert_claim(
    tx: &Connection,
    id: &str,
    claim: &ExtractClaim,
    evidence: Option<&Vec<ValidatedQuote>>,
) -> CognitionResult<()> {
    let mut classes = HashSet::new();
    for quote in evidence.into_iter().flatten() {
        let row = tx
            .query_row(
                "SELECT role,source_kind,origin_kind FROM memory_chunk_sources WHERE source_id=?1",
                [&quote.source_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .map_err(db_error)?;
        classes.insert(if row.1 == "task_report" {
            "task_report"
        } else if row.1 == "explicit_record" {
            "explicit"
        } else if row.0 == "user" && row.2 == "user_input" {
            "user"
        } else if row.0 == "assistant" && row.2 == "assistant_public" {
            "assistant"
        } else {
            "unknown"
        });
    }
    let source_class = if classes.len() > 1 {
        "mixed"
    } else {
        classes.into_iter().next().unwrap_or("unknown")
    };
    let requirement = claim.requirement.as_ref().map(stringify).transpose()?;
    tx.execute("INSERT OR IGNORE INTO memory_claims(node_id,statement,speech_act,basis,polarity,condition,requirement,valid_from,valid_to,salience,source_class) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![id,claim.statement,claim.speech_act,claim.basis,claim.polarity,claim.condition,requirement,claim.valid_from,claim.valid_to,claim.salience,source_class]).map_err(db_error)?;
    Ok(())
}

pub(super) fn record_mention(
    tx: &Connection,
    node: &str,
    source: &str,
    surface: &str,
    text: &str,
    byte_start: usize,
) -> CognitionResult<()> {
    if surface.is_empty() {
        return Err(error("memory_mention_empty"));
    }
    let span = text.find(surface).map(|offset| byte_start + offset);
    tx.execute("INSERT OR IGNORE INTO memory_mentions(node_id,source_id,byte_start,byte_end,surface,method) VALUES(?1,?2,?3,?4,?5,?6)",params![node,source,span.map(|x|x as i64),span.map(|x|(x+surface.len()) as i64),surface,if span.is_some(){"literal"}else{"inferred"}]).map_err(db_error)?;
    Ok(())
}

pub(super) fn update_summary(
    tx: &Connection,
    job: &str,
    input: &ExtractInput,
    output: &ExtractOutput,
) -> CognitionResult<()> {
    let mut statement=tx.prepare("SELECT window_ref,state,output_json FROM memory_projection_windows WHERE job_id=?1 ORDER BY ordinal").map_err(db_error)?;
    let rows = statement
        .query_map([job], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(db_error)?;
    let mut summaries = Vec::new();
    for row in rows {
        let (window, state, saved) = row.map_err(db_error)?;
        if window == input.window_ref {
            if let Some(summary) = &output.summary {
                summaries.push(summary.text.clone());
            }
        } else if state == "complete"
            && let Some(text) = saved
                .and_then(|json| serde_json::from_str::<Value>(&json).ok())
                .and_then(|value| {
                    value
                        .get("summary")
                        .and_then(|item| item.get("text"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
        {
            summaries.push(text);
        }
    }
    let joined = summaries.join("\n\n");
    let prior = tx
        .query_row(
            "SELECT summary FROM memory_chunks WHERE memory_chunk_id=?1",
            [&input.episode_ref],
            |row| row.get::<_, String>(0),
        )
        .map_err(db_error)?;
    tx.execute(
        "UPDATE memory_chunks SET summary=?1,summary_status='complete' WHERE memory_chunk_id=?2",
        params![joined, input.episode_ref],
    )
    .map_err(db_error)?;
    if joined != prior {
        tx.execute("UPDATE memory_projection_jobs SET hot_cache_state=?1,hot_cache_receipt_json=NULL,hot_cache_next_attempt_at=NULL WHERE job_id=?2",params![json!({"state":"pending","blocked_by":null}).to_string(),job]).map_err(db_error)?;
    }
    Ok(())
}
