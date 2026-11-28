//! Scoped conversation claims for model-kept pages.
use rusqlite::{OptionalExtension, named_params};

use super::{GraphRepository, db_error};
use crate::cognition::{
    CognitionResult,
    standing::{Page, Pass},
};

/// Current conversation claims of a page's scope. `:project` is NULL for the user sheet.
const USER_SOURCES: &str = "FROM memory_claims c
JOIN memory_nodes n ON n.id = c.node_id
JOIN memory_evidence e ON e.node_id = c.node_id
JOIN memory_chunks k ON k.memory_chunk_id = e.episode_id AND k.current_revision = e.revision
WHERE c.basis = 'user_statement' AND k.status = 'active' AND k.project_id IS NULL AND :project IS NULL
AND substr(k.source_key, 1, 13) = 'conversation_'";

const PROJECT_SOURCES: &str = "FROM memory_claims c
JOIN memory_nodes n ON n.id = c.node_id
JOIN memory_evidence e ON e.node_id = c.node_id
JOIN memory_chunks k ON k.memory_chunk_id = e.episode_id AND k.current_revision = e.revision
WHERE c.source_class IN ('user', 'assistant') AND k.status = 'active' AND k.project_id = :project
AND substr(k.source_key, 1, 13) = 'conversation_'";

/// One claim of a pass: `t` is its conversation time.
const PASS_ROWS: &str = "SELECT n.created_at AS a, n.id AS i,
    MIN(COALESCE(k.conversation_start, k.created_at)) AS t,
    c.source_class AS speaker,
    CASE n.type WHEN 'memory_atom' THEN c.speech_act ELSE n.type END AS kind,
    c.statement AS statement,
    c.valid_from AS valid_from, c.valid_to AS valid_to";

const PASS_RANGE: &str = "AND (n.created_at, n.id) > (:from_at, :from_id)
    AND (n.created_at, n.id) <= (:to_at, :to_id) GROUP BY c.node_id";

const USER_MENTIONS: &str = "(SELECT COUNT(DISTINCT ev.episode_id) FROM edges s
    JOIN memory_aliases a1 ON a1.node_id = s.target_node_id
    JOIN memory_aliases a2 ON a2.folded_key = a1.folded_key
    JOIN memory_evidence ev ON ev.node_id = a2.node_id
    WHERE s.source_node_id = i AND s.rel_type = 'has_subject' AND s.status = 'active')";

/// A statement to fold, with its sort key.
pub(in crate::cognition) struct StandingRow {
    pub time: String,
    pub at: String,
    pub id: String,
    pub label: String,
    pub statement: String,
    /// Conversations in which the statement's subject name has come up; 0 when unknown.
    pub mentions: u64,
    /// The period the speaker gave, as written.
    pub valid_from: Option<String>,
    pub valid_to: Option<String>,
}

impl StandingRow {
    pub(in crate::cognition) fn line(&self) -> String {
        let statement = self
            .statement
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let mut label = self.label.clone();
        if self.mentions >= 2 {
            label.push_str(&format!(" ×{}", self.mentions));
        }
        let mut line = format!("[{label}] {statement}");
        let from = self
            .valid_from
            .as_deref()
            .filter(|value| !value.trim().is_empty());
        let to = self
            .valid_to
            .as_deref()
            .filter(|value| !value.trim().is_empty());
        match (from, to) {
            (Some(from), Some(to)) => line.push_str(&format!(" (from {from} until {to})")),
            (Some(from), None) => line.push_str(&format!(" (from {from})")),
            (None, Some(to)) => line.push_str(&format!(" (until {to})")),
            (None, None) => {}
        }
        line
    }
}

fn sources(page: &Page) -> &'static str {
    match page {
        Page::User => USER_SOURCES,
        Page::Project(_) => PROJECT_SOURCES,
    }
}

impl GraphRepository {
    pub(in crate::cognition) fn standing_sources(
        &self,
        page: &Page,
        through_at: &str,
        through_id: &str,
    ) -> CognitionResult<u64> {
        let sources = sources(page);
        self.connection()?.query_row(
            &format!("SELECT COUNT(DISTINCT c.node_id) {sources} AND (n.created_at, n.id) <= (:to_at, :to_id)"),
            named_params! {":project": page.project(), ":to_at": through_at, ":to_id": through_id},
            |row| row.get(0),
        ).map_err(db_error)
    }

    pub(in crate::cognition) fn standing_newest(
        &self,
        page: &Page,
        from_at: &str,
        from_id: &str,
    ) -> CognitionResult<Option<(String, String)>> {
        let sources = sources(page);
        self.connection()?.query_row(
            &format!("SELECT n.created_at, n.id {sources} AND (n.created_at, n.id) > (:from_at, :from_id) ORDER BY n.created_at DESC, n.id DESC LIMIT 1"),
            named_params! {":project": page.project(), ":from_at": from_at, ":from_id": from_id},
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(db_error)
    }

    pub(in crate::cognition) fn standing_rows(
        &self,
        page: &Page,
        from_at: &str,
        from_id: &str,
        pass: &Pass,
        limit: usize,
    ) -> CognitionResult<Vec<StandingRow>> {
        let sources = sources(page);
        let (label, mentions) = match page {
            Page::User => ("substr(t, 1, 10)", USER_MENTIONS),
            Page::Project(_) => ("substr(t, 1, 10) || ' ' || speaker || ' ' || kind", "0"),
        };
        let (time, at, id) = &pass.at;
        self.connection()?
            .prepare(&format!(
                "SELECT a, i, t, {label}, statement, valid_from, valid_to, {mentions} AS mentions
                 FROM (
                     SELECT * FROM ({PASS_ROWS} {sources} {PASS_RANGE})
                     WHERE (t, a, i) > (:t, :a, :i) ORDER BY t, a, i LIMIT :limit
                 )
                 ORDER BY t, a, i"
            ))
            .map_err(db_error)?
            .query_map(
                named_params! {
                    ":project": page.project(), ":from_at": from_at, ":from_id": from_id,
                    ":to_at": pass.to_at, ":to_id": pass.to_id, ":t": time, ":a": at, ":i": id,
                    ":limit": limit,
                },
                |row| {
                    Ok(StandingRow {
                        at: row.get(0)?,
                        id: row.get(1)?,
                        time: row.get(2)?,
                        label: row.get(3)?,
                        statement: row.get(4)?,
                        valid_from: row.get(5)?,
                        valid_to: row.get(6)?,
                        mentions: row.get(7)?,
                    })
                },
            )
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)
    }

    pub(in crate::cognition) fn standing_pass_sources(
        &self,
        page: &Page,
        from_at: &str,
        from_id: &str,
        pass: &Pass,
    ) -> CognitionResult<u64> {
        let sources = sources(page);
        let (time, at, id) = &pass.at;
        self.connection()?.query_row(
            &format!("SELECT COUNT(*) FROM ({PASS_ROWS} {sources} {PASS_RANGE}) WHERE (t, a, i) <= (:t, :a, :i)"),
            named_params! {
                ":project": page.project(), ":from_at": from_at, ":from_id": from_id,
                ":to_at": pass.to_at, ":to_id": pass.to_id, ":t": time, ":a": at, ":i": id,
            },
            |row| row.get(0),
        ).map_err(db_error)
    }

    pub(in crate::cognition) fn standing_projects(&self) -> CognitionResult<Vec<String>> {
        self.connection()?.prepare(
            "SELECT project_id FROM memory_chunks WHERE status = 'active' AND project_id IS NOT NULL
             AND substr(source_key, 1, 13) = 'conversation_' GROUP BY project_id
             ORDER BY MAX(COALESCE(conversation_start, created_at)) DESC, project_id"
        ).map_err(db_error)?.query_map([], |row| row.get(0))
            .map_err(db_error)?.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }
}
