//! Read-only pinned graph owner for one source-backed recall operation.

mod adjacency;
mod claims;
mod coverage;
mod episodes;
mod identity;
mod mentions;
mod raw;
mod relationships;
mod scope;
mod semantic;
mod sources;
mod temporal;
mod vectors;

use std::{path::Path, time::Duration};

use rusqlite::{Connection, OpenFlags, OptionalExtension};

use super::db_error;
use crate::cognition::recall::{
    EligibleAdjacency, IdentityMembersResult, IdentityReadScope, IdentityResolution,
    IdentitySourceBinding, RecallRequest, RecallVectorMatch, SemanticSelection,
};
use crate::cognition::{CognitionError, CognitionResult};

pub(in crate::cognition) use coverage::ProjectionCoverage;
pub(in crate::cognition) use episodes::RecallEpisodeRow;
pub(in crate::cognition) use mentions::RecallMention;
pub(in crate::cognition) use raw::RawSourceSelection;
pub(in crate::cognition) use relationships::RelationshipState;
pub(in crate::cognition) use temporal::TemporalSelection;
pub(in crate::cognition) use vectors::CurrentVectorMatches;

pub(in crate::cognition) struct GraphRecallReader {
    connection: Option<Connection>,
    revision: String,
}

impl GraphRecallReader {
    pub(in crate::cognition) fn current_vector_matches(
        &self,
        input: &RecallRequest,
        generation: &crate::cognition::MemoryGenerationHandle,
        matches: &crate::cognition::recall::RecallVectorMatches,
        parse_date: &dyn Fn(&str) -> f64,
    ) -> CognitionResult<CurrentVectorMatches> {
        vectors::current(self.connection()?, input, generation, matches, parse_date)
    }
    pub(in crate::cognition) fn open(path: &Path) -> CognitionResult<Self> {
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(db_error)?;
        connection
            .busy_timeout(Duration::from_millis(5_000))
            .map_err(db_error)?;
        connection
            .pragma_update(None, "query_only", "ON")
            .map_err(db_error)?;
        connection.execute_batch("BEGIN").map_err(db_error)?;
        let revision = connection
            .query_row(
                "SELECT value FROM memory_state WHERE key='graph_revision'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?
            .unwrap_or_else(|| "0".into());
        Ok(Self {
            connection: Some(connection),
            revision,
        })
    }

    pub(in crate::cognition) fn revision(&self) -> &str {
        &self.revision
    }

    pub(in crate::cognition) fn raw_source_candidates(
        &self,
        input: &RecallRequest,
        deadline_at: i64,
        now_millis: impl FnMut() -> i64,
    ) -> CognitionResult<RawSourceSelection> {
        raw::select(self.connection()?, input, deadline_at, now_millis)
    }

    pub(in crate::cognition) fn semantic_seeds(
        &self,
        input: &RecallRequest,
        recent_message_ids: &[String],
        vector_nodes: &[RecallVectorMatch],
        deadline_at: i64,
        now_millis: impl FnMut() -> i64,
    ) -> CognitionResult<SemanticSelection> {
        semantic::select(
            self.connection()?,
            input,
            recent_message_ids,
            vector_nodes,
            deadline_at,
            now_millis,
        )
    }

    pub(in crate::cognition) fn temporal_seeds(
        &self,
        input: &RecallRequest,
        parse_date: impl Fn(&str) -> f64,
    ) -> CognitionResult<TemporalSelection> {
        temporal::select(self.connection()?, input, parse_date)
    }

    pub(in crate::cognition) fn resolve_identity(
        &self,
        node_id: &str,
        scope: &IdentityReadScope,
        parse_date: &dyn Fn(&str) -> f64,
        source_current: &mut impl FnMut(&IdentitySourceBinding) -> bool,
        now_millis: &mut impl FnMut() -> i64,
    ) -> CognitionResult<IdentityResolution> {
        identity::resolve(
            self.connection()?,
            node_id,
            scope,
            parse_date,
            source_current,
            now_millis,
        )
    }

    pub(in crate::cognition) fn identity_members(
        &self,
        target: &str,
        scope: &IdentityReadScope,
        limit: usize,
        parse_date: &dyn Fn(&str) -> f64,
        source_current: &mut impl FnMut(&IdentitySourceBinding) -> bool,
        now_millis: &mut impl FnMut() -> i64,
    ) -> CognitionResult<IdentityMembersResult> {
        identity::members(
            self.connection()?,
            target,
            scope,
            limit,
            parse_date,
            source_current,
            now_millis,
        )
    }

    pub(in crate::cognition) fn eligible_adjacency(
        &self,
        input: &RecallRequest,
        node_id: &str,
        limit: usize,
        offset: usize,
    ) -> CognitionResult<EligibleAdjacency> {
        adjacency::load(self.connection()?, input, node_id, limit, offset)
    }

    pub(in crate::cognition) fn mentions_for_nodes(
        &self,
        input: &RecallRequest,
        ids: &[String],
    ) -> CognitionResult<Vec<RecallMention>> {
        mentions::for_nodes(self.connection()?, input, ids)
    }

    pub(in crate::cognition) fn mentions_for_episodes(
        &self,
        input: &RecallRequest,
        ids: &[String],
    ) -> CognitionResult<Vec<RecallMention>> {
        mentions::for_episodes(self.connection()?, input, ids)
    }

    pub(in crate::cognition) fn episode_sources(
        &self,
        input: &RecallRequest,
        ids: &[String],
    ) -> CognitionResult<Vec<RecallMention>> {
        mentions::episode_sources(self.connection()?, input, ids)
    }

    pub(in crate::cognition) fn episode_rows(
        &self,
        input: &RecallRequest,
        ids: &[String],
        raw: &std::collections::HashSet<String>,
    ) -> CognitionResult<Vec<RecallEpisodeRow>> {
        episodes::load(self.connection()?, input, ids, raw)
    }

    pub(in crate::cognition) fn episode_identity(
        &self,
        episode_id: &str,
    ) -> CognitionResult<Option<crate::cognition::recall::RecallSourceEpisode>> {
        self.connection()?.query_row(
            "SELECT memory_chunk_id,current_revision,conversation_session_id,conversation_turn_id
             FROM memory_chunks WHERE memory_chunk_id=?1",
            [episode_id],
            |row| Ok(crate::cognition::recall::RecallSourceEpisode {
                episode_id: row.get(0)?,revision:row.get(1)?,session_id:row.get(2)?,turn_id:row.get(3)?,
            }),
        ).optional().map_err(db_error)
    }

    pub(in crate::cognition) fn relationship_state(
        &self,
        input: &RecallRequest,
        episode_id: &str,
        now_iso: &str,
    ) -> CognitionResult<RelationshipState> {
        relationships::state(self.connection()?, input, episode_id, now_iso)
    }

    pub(in crate::cognition) fn support_count(
        &self,
        input: &RecallRequest,
        episode_id: &str,
    ) -> CognitionResult<f64> {
        relationships::support_count(self.connection()?, input, episode_id)
    }

    pub(in crate::cognition) fn historical_claim(
        &self,
        input: &RecallRequest,
        episode_id: &str,
        now_iso: &str,
        parse_date: impl Fn(&str) -> f64,
    ) -> CognitionResult<bool> {
        relationships::historical_claim(self.connection()?, input, episode_id, now_iso, parse_date)
    }

    pub(in crate::cognition) fn node_type(&self, node_id: &str) -> CognitionResult<Option<String>> {
        claims::node_type(self.connection()?, node_id)
    }

    pub(in crate::cognition) fn matched_claim_summary(
        &self,
        input: &RecallRequest,
        episode_id: &str,
        matched_node_id: Option<&str>,
        mentions: &[RecallMention],
        surviving: &std::collections::HashSet<String>,
    ) -> CognitionResult<Option<String>> {
        claims::matched_summary(
            self.connection()?,
            input,
            episode_id,
            matched_node_id,
            mentions,
            surviving,
        )
    }

    pub(in crate::cognition) fn result_requirements(
        &self,
        input: &RecallRequest,
        refs: &[(String, String)],
    ) -> CognitionResult<Vec<crate::cognition::recall::RecallRequirement>> {
        claims::result_requirements(self.connection()?, input, refs)
    }

    pub(in crate::cognition) fn result_interpretations(
        &self,
        input: &RecallRequest,
        refs: &[(String, String)],
        parse_date: impl Fn(&str) -> f64,
    ) -> CognitionResult<Vec<crate::cognition::recall::RecallInterpretation>> {
        claims::result_interpretations(self.connection()?, input, refs, parse_date)
    }

    pub(in crate::cognition) fn source_rows(
        &self,
        ids: &[String],
    ) -> CognitionResult<Vec<crate::cognition::CognitionSourceRow>> {
        sources::rows(self.connection()?, ids)
    }

    pub(in crate::cognition) fn source_project_id(
        &self,
        episode_id: &str,
    ) -> CognitionResult<Option<String>> {
        sources::project_id(self.connection()?, episode_id)
    }

    pub(in crate::cognition) fn projection_coverage(
        &self,
        input: &RecallRequest,
        inventory: &crate::cognition::sources::CanonicalInventory,
    ) -> CognitionResult<ProjectionCoverage> {
        coverage::graph(self.connection()?, input, inventory)
    }

    pub(in crate::cognition) fn quality_receipt_json(
        &self,
        operation_id: &str,
    ) -> CognitionResult<Option<String>> {
        self.connection()?
            .query_row(
                "SELECT value FROM memory_state WHERE key=?1",
                [format!("quality_operation:{operation_id}")],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)
    }

    pub(in crate::cognition) fn close(mut self) -> CognitionResult<()> {
        let Some(connection) = self.connection.take() else {
            return Ok(());
        };
        let rollback = connection.execute_batch("ROLLBACK").map_err(db_error);
        let close = connection.close().map_err(|(_, error)| db_error(error));
        rollback.and(close)
    }

    fn connection(&self) -> CognitionResult<&Connection> {
        self.connection
            .as_ref()
            .ok_or_else(|| CognitionError::new("memory_graph_closed", "memory_graph_closed"))
    }
}

impl Drop for GraphRecallReader {
    fn drop(&mut self) {
        if let Some(connection) = self.connection.take() {
            let _ = connection.execute_batch("ROLLBACK");
            let _ = connection.close();
        }
    }
}
