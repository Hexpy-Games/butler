//! Atomic provisional and final graph writes for one owned semantic window.

pub(in crate::cognition::graph) mod context;
mod edges;
mod nodes;

use crate::cognition::CognitionCode;
use context::resolve_quotes;
use nodes::{insert_alias, insert_claim, record_mention, update_summary, upsert_node};

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::json;

use super::{db_error, jobs, plan::NormalizedPlan, recall_index};
use crate::cognition::{
    CognitionError, CognitionResult,
    extraction::{ExtractInput, ExtractOutput},
    graph::ProjectionWindowOwner,
};

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum ApplyStage {
    Meaning,
    Bound,
}

#[derive(Clone, Copy)]
struct PlanApplication<'a> {
    owner: ProjectionWindowOwner<'a>,
    input: &'a ExtractInput,
    output: &'a ExtractOutput,
    plan: &'a NormalizedPlan,
    candidates: &'a HashMap<String, String>,
    now: &'a str,
    stage: ApplyStage,
}

pub(super) fn commit_meaning(
    connection: &mut Connection,
    job: &str,
    window: &str,
    nonce: &str,
    input: &ExtractInput,
    output: &ExtractOutput,
    now: &str,
) -> CognitionResult<()> {
    let tx = connection.transaction().map_err(db_error)?;
    let owner = ProjectionWindowOwner {
        job_id: job,
        window_ref: window,
        nonce,
    };
    assert_owner(&tx, owner, "running", input)?;
    let hash = meaning_input_hash(input)?;
    let output_json = stringify(output)?;
    let previous = tx
        .query_row(
            "SELECT input_hash,output_json FROM memory_meaning_commits WHERE window_ref=?1",
            [window],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    if let Some((old_hash, old_output)) = previous {
        if old_hash != hash || old_output != output_json {
            return Err(error(CognitionCode::MemoryMeaningChanged));
        }
        tx.commit().map_err(db_error)?;
        return Ok(());
    }
    let plan = super::plan::normalize(&tx, input, output)?;
    apply_plan(
        &tx,
        PlanApplication {
            owner,
            input,
            output,
            plan: &plan,
            candidates: &HashMap::new(),
            now,
            stage: ApplyStage::Meaning,
        },
    )?;
    tx.execute("INSERT INTO memory_meaning_commits(window_ref,input_hash,output_json,plan_json,committed_at) VALUES(?1,?2,?3,?4,?5)",params![window,hash,output_json,stringify(&plan)?,now]).map_err(db_error)?;
    recall_index::install_and_backfill(&tx)?;
    tx.commit().map_err(db_error)
}

pub(super) fn apply_final(
    connection: &mut Connection,
    owner: ProjectionWindowOwner<'_>,
    input: &ExtractInput,
    output: &ExtractOutput,
    plan: &NormalizedPlan,
    now: &str,
) -> CognitionResult<()> {
    let tx = connection.transaction().map_err(db_error)?;
    assert_owner(&tx, owner, "planned", input)?;
    let candidate_resolutions = assert_candidates_current(&tx, input, plan)?;
    apply_plan(
        &tx,
        PlanApplication {
            owner,
            input,
            output,
            plan,
            candidates: &candidate_resolutions,
            now,
            stage: ApplyStage::Bound,
        },
    )?;
    recall_index::install_and_backfill(&tx)?;
    tx.commit().map_err(db_error)
}

/// Quotes resolved to source leaves, by local ref.
type ResolvedEvidence = HashMap<String, Vec<super::plan::ValidatedQuote>>;

/// Writes a plan's nodes, claims, and relations. The meaning stage stops
/// there; the bound stage also links identities, applies corrections and the
/// summary, and completes the window.
fn apply_plan(tx: &Transaction<'_>, application: PlanApplication<'_>) -> CognitionResult<()> {
    let PlanApplication {
        owner,
        input,
        output,
        plan,
        now,
        stage,
        ..
    } = application;
    let window = owner.window_ref;
    if output.disposition == "unsupported" {
        if stage == ApplyStage::Bound {
            tx.execute("UPDATE memory_projection_windows SET state='unsupported',error_code=NULL,owner_pid=NULL,owner_nonce=NULL,started_at=NULL WHERE window_ref=?1",[window]).map_err(db_error)?;
            jobs::refresh_semantic_state(tx, owner.job_id, now)?;
        }
        return Ok(());
    }
    let resolved = plan
        .evidence
        .iter()
        .map(|(reference, quotes)| Ok((reference.clone(), resolve_quotes(tx, input, quotes)?)))
        .collect::<CognitionResult<ResolvedEvidence>>()?;
    for node in &output.nodes {
        application.apply_node(tx, node, &resolved)?;
    }
    for claim in &output.claims {
        application.apply_claim(tx, claim, &resolved)?;
    }
    for relation in &output.relations {
        application.apply_relation(tx, relation)?;
    }
    if stage == ApplyStage::Meaning {
        return increment_graph_revision(tx);
    }
    application.complete_window(tx)
}

impl PlanApplication<'_> {
    fn node_id(&self, local_ref: &str) -> CognitionResult<&String> {
        self.plan
            .refs
            .get(local_ref)
            .ok_or_else(|| error(CognitionCode::MemoryExtractInvalidRef))
    }

    fn apply_node(
        &self,
        tx: &Transaction<'_>,
        node: &crate::cognition::extraction::ExtractNode,
        resolved: &ResolvedEvidence,
    ) -> CognitionResult<()> {
        let (input, window) = (self.input, self.owner.window_ref);
        let id = self.node_id(&node.local_ref)?;
        upsert_node(
            tx,
            nodes::NodeUpsert {
                id,
                node_type: &node.node_type,
                label: &node.label,
                resolution: &node.resolution,
                input,
                window,
                now: self.now,
                evidence: resolved.get(&node.local_ref),
            },
        )?;
        for quote in resolved.get(&node.local_ref).into_iter().flatten() {
            record_mention(
                tx,
                id,
                &quote.source_id,
                &node.label,
                &quote.quote,
                quote.byte_start,
            )?;
        }
        if self.stage == ApplyStage::Bound {
            edges::identity_match(tx, input, self.plan, self.candidates, id, &node.resolution)?;
        }
        let aliases = std::iter::once((&node.label, &node.evidence)).chain(
            node.aliases
                .iter()
                .map(|alias| (&alias.text, &alias.evidence)),
        );
        for (text, evidence) in aliases {
            let validated = super::plan::validate_quotes_for_apply(input, evidence)?;
            for quote in resolve_quotes(tx, input, &validated)? {
                record_mention(
                    tx,
                    id,
                    &quote.source_id,
                    text,
                    &quote.quote,
                    quote.byte_start,
                )?;
                insert_alias(tx, id, text, &quote.source_id, node.resolution.kind())?;
            }
        }
        Ok(())
    }

    fn apply_claim(
        &self,
        tx: &Transaction<'_>,
        claim: &crate::cognition::extraction::ExtractClaim,
        resolved: &ResolvedEvidence,
    ) -> CognitionResult<()> {
        let id = self.node_id(&claim.local_ref)?;
        upsert_node(
            tx,
            nodes::NodeUpsert {
                id,
                node_type: &claim.claim_type,
                label: &claim.statement,
                resolution: &claim.resolution,
                input: self.input,
                window: self.owner.window_ref,
                now: self.now,
                evidence: resolved.get(&claim.local_ref),
            },
        )?;
        insert_claim(tx, id, claim, resolved.get(&claim.local_ref))?;
        if self.stage == ApplyStage::Bound {
            edges::same_claim(
                tx,
                self.input,
                self.plan,
                self.candidates,
                id,
                &claim.resolution,
            )?;
        }
        for quote in resolved.get(&claim.local_ref).into_iter().flatten() {
            insert_alias(
                tx,
                id,
                &claim.statement,
                &quote.source_id,
                claim.resolution.kind(),
            )?;
        }
        let roles = [
            ("has_subject", claim.subject_ref.as_ref()),
            ("has_object", claim.object_ref.as_ref()),
        ];
        for (relation, target) in roles {
            let Some(target) = target else {
                continue;
            };
            edges::add(
                tx,
                edges::EdgeInput {
                    input: self.input,
                    plan: self.plan,
                    relation,
                    from: &claim.local_ref,
                    to: target,
                    claim: &claim.local_ref,
                    evidence: &claim.evidence,
                    basis: &claim.basis,
                },
            )?;
        }
        Ok(())
    }

    fn apply_relation(
        &self,
        tx: &Transaction<'_>,
        relation: &crate::cognition::extraction::ExtractRelation,
    ) -> CognitionResult<()> {
        let claim = self
            .output
            .claims
            .iter()
            .find(|claim| claim.local_ref == relation.claim_ref)
            .ok_or_else(|| error(CognitionCode::MemoryExtractInvalidRelation))?;
        edges::add(
            tx,
            edges::EdgeInput {
                input: self.input,
                plan: self.plan,
                relation: &relation.relation,
                from: &relation.from_ref,
                to: &relation.to_ref,
                claim: &relation.claim_ref,
                evidence: &relation.evidence,
                basis: &claim.basis,
            },
        )
    }

    /// Applies corrections and the summary, then marks the window complete.
    fn complete_window(&self, tx: &Transaction<'_>) -> CognitionResult<()> {
        let (job, window, now) = (self.owner.job_id, self.owner.window_ref, self.now);
        edges::refinements_and_corrections(tx, self.input, self.output, self.plan)?;
        if self.output.summary.is_some() {
            update_summary(tx, job, self.input, self.output)?;
        }
        tx.execute("UPDATE memory_projection_windows SET state='complete',error_code=NULL,owner_pid=NULL,owner_nonce=NULL,started_at=NULL WHERE window_ref=?1",[window]).map_err(db_error)?;
        tx.execute("INSERT OR REPLACE INTO memory_projection_attempts(attempt_ref,window_ref,job_id,attempt_count,state,error_code,input_sha256,output_json,provider_evidence_json,recorded_at,attempt_kind,provider_invoked,outcome_known,recovery_revision) SELECT window_ref||':attempt:'||attempt_count||':complete',window_ref,job_id,attempt_count,'complete',NULL,input_sha256,NULL,NULL,?1,'apply',0,1,recovery_revision FROM memory_projection_windows WHERE window_ref=?2",params![now,window]).map_err(db_error)?;
        increment_graph_revision(tx)?;
        jobs::refresh_semantic_state(tx, job, now)
    }
}

fn assert_owner(
    tx: &Connection,
    owner: ProjectionWindowOwner<'_>,
    state: &str,
    input: &ExtractInput,
) -> CognitionResult<()> {
    let row=tx.query_row("SELECT j.episode_id,j.revision,c.current_revision,c.project_id,w.state,w.owner_nonce FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE w.window_ref=?1 AND w.job_id=?2",params![owner.window_ref,owner.job_id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,String>(4)?,row.get::<_,Option<String>>(5)?))).optional().map_err(db_error)?.ok_or_else(changed)?;
    if row.0 != input.episode_ref
        || row.1 != input.revision
        || row.2 != input.revision
        || row.3 != input.bound_project_id
        || row.4 != state
        || row.5.as_deref() != Some(owner.nonce)
    {
        return Err(changed());
    }
    Ok(())
}

fn assert_candidates_current(
    tx: &Connection,
    input: &ExtractInput,
    plan: &NormalizedPlan,
) -> CognitionResult<HashMap<String, String>> {
    let mut resolved = HashMap::new();
    for binding in plan.candidate_bindings.values() {
        let node=tx.query_row("SELECT type,identity_scope,project_id,COALESCE(canonical_node_id,id) FROM memory_nodes WHERE id=?1",[&binding.node_ref],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,String>(3)?))).optional().map_err(db_error)?.ok_or_else(candidate_changed)?;
        if node.0 != binding.node_type
            || node.1 != binding.scope
            || node.2 != binding.project_id
            || (node.1 == "project" && node.2 != input.bound_project_id)
        {
            return Err(candidate_changed());
        }
        for evidence in &binding.evidence {
            let current=tx.query_row("SELECT s.episode_id,s.revision,s.content_hash,c.current_revision FROM memory_chunk_sources s JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id WHERE s.source_id=?1",[&evidence.source_ref],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?))).optional().map_err(db_error)?.ok_or_else(candidate_changed)?;
            if current.0 != evidence.episode_ref
                || current.1 != evidence.revision
                || current.2 != evidence.content_hash
                || current.3 != evidence.revision
            {
                return Err(candidate_changed());
            }
        }
        resolved.insert(binding.node_ref.clone(), node.3);
    }
    Ok(resolved)
}

fn meaning_input_hash(input: &ExtractInput) -> CognitionResult<String> {
    let mut value = serde_json::to_value(input).map_err(json_error)?;
    let Some(object) = value.as_object_mut() else {
        return Err(CognitionError::new(
            CognitionCode::MemoryExtractInvalidJson,
            "meaning input is not an object",
        ));
    };
    object.insert("candidates".into(), json!([]));
    crate::cognition::sources::projection_hash_for_graph(vec![json!("meaning-input"), value])
}
fn increment_graph_revision(tx: &Connection) -> CognitionResult<()> {
    tx.execute(
        "UPDATE memory_state SET value=CAST(value AS INTEGER)+1 WHERE key='graph_revision'",
        [],
    )
    .map_err(db_error)?;
    Ok(())
}
fn stringify<T: serde::Serialize>(value: &T) -> CognitionResult<String> {
    butler_core::json::stringify(&serde_json::to_value(value).map_err(json_error)?)
        .map_err(json_error)
}
fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
fn changed() -> CognitionError {
    error(CognitionCode::MemoryProjectionWindowChanged)
}
fn candidate_changed() -> CognitionError {
    error(CognitionCode::MemoryExtractCandidateChanged)
}
fn source_changed() -> CognitionError {
    error(CognitionCode::MemorySourceChanged)
}
fn json_error(error: impl std::error::Error + Send + Sync + 'static) -> CognitionError {
    CognitionError::new(CognitionCode::MemoryExtractInvalidJson, error.to_string())
        .with_source(error)
}
