//! Read-only source coverage health, with canonical source currentness checks.

use std::path::Path;

use rusqlite::OptionalExtension;
use serde::Serialize;
use serde_json::Value;

use super::{contracts::CanonicalProfileSourceFactory, storage};

/// How much of the user's conversation the profile extractor has covered.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProfileCoverageHealth {
    /// Whether the profile store could be read.
    pub available: bool,
    /// Why it could not be read.
    pub reason: Option<&'static str>,
    /// The profiling consent mode (`off`, `basic`, `deep`).
    pub consent_mode: &'static str,
    /// Current source windows fully processed.
    pub processed_windows: usize,
    /// Current source windows waiting for extraction.
    pub pending_windows: usize,
    /// Current source windows whose extraction failed.
    pub failed_windows: usize,
    /// Windows whose source changed or disappeared since extraction.
    pub stale_history_windows: usize,
    /// Windows ever processed, current or not.
    pub historical_processed_windows: usize,
    /// `true` while source discovery has not reached the end.
    pub discovery_incomplete: Option<bool>,
    /// Why discovery progress is unknown.
    pub discovery_reason: Option<&'static str>,
}

struct CoverageRow {
    disposition: String,
    failure_code: Option<String>,
    message_id: String,
    part_id: String,
    pointer: String,
    source_hash: String,
    byte_start: i64,
    byte_end: i64,
}

pub(super) fn read(
    data_root: &Path,
    sources: &dyn CanonicalProfileSourceFactory,
) -> ProfileCoverageHealth {
    if !storage::database_path(data_root).exists() {
        return unavailable("profile_store_unavailable");
    }
    read_open(data_root, sources).unwrap_or_else(|| unavailable("profile_coverage_unavailable"))
}

fn read_open(
    data_root: &Path,
    sources: &dyn CanonicalProfileSourceFactory,
) -> Option<ProfileCoverageHealth> {
    let db = storage::open(data_root, storage::Access::Read).ok()?;
    let consent = storage::read_consent(data_root);
    let rows = coverage_rows(&db)?;
    let mut reader = sources.open().ok()?;
    let counts = tally(reader.as_mut(), rows, consent.mode);
    let closed = reader.close();
    let counts = counts.filter(|_| closed.is_ok())?;
    let offset = db
        .query_row(
            "SELECT value_json FROM profile_meta WHERE key='source_scan_offset'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.as_i64());
    let discovery = offset.filter(|value| *value > 0).map(|_| true);
    Some(ProfileCoverageHealth {
        available: true,
        reason: None,
        consent_mode: consent.mode.as_str(),
        processed_windows: counts.processed,
        pending_windows: counts.pending,
        failed_windows: counts.failed,
        stale_history_windows: counts.stale,
        historical_processed_windows: counts.historical,
        discovery_incomplete: discovery,
        discovery_reason: discovery.is_none().then_some("discovery_not_observed"),
    })
}

fn coverage_rows(db: &rusqlite::Connection) -> Option<Vec<CoverageRow>> {
    let mut statement = db.prepare("SELECT disposition,failure_code,message_id,part_id,scalar_pointer,source_hash,byte_start,byte_end FROM profile_source_coverage").ok()?;
    statement
        .query_map([], |row| {
            Ok(CoverageRow {
                disposition: row.get(0)?,
                failure_code: row.get(1)?,
                message_id: row.get(2)?,
                part_id: row.get(3)?,
                pointer: row.get(4)?,
                source_hash: row.get(5)?,
                byte_start: row.get(6)?,
                byte_end: row.get(7)?,
            })
        })
        .ok()?
        .collect::<Result<Vec<_>, _>>()
        .ok()
}

/// Coverage windows by state.
#[derive(Default)]
struct Counts {
    processed: usize,
    pending: usize,
    failed: usize,
    /// Windows whose source text changed or disappeared.
    stale: usize,
    /// Windows ever completed, current or not.
    historical: usize,
}

/// Counts each row against the current source text; `None` when a message
/// cannot be read.
fn tally(
    reader: &mut dyn super::CanonicalProfileSourceReader,
    rows: Vec<CoverageRow>,
    mode: super::ProfilingMode,
) -> Option<Counts> {
    let mut counts = Counts::default();
    for row in rows {
        if row.disposition == "complete" {
            counts.historical += 1;
        }
        let message = reader.read_message(&row.message_id).ok()?;
        let current = message
            .as_ref()
            .is_some_and(|message| still_current(&row, message));
        if row.failure_code.as_deref() == Some("source_stale") || !current {
            counts.stale += 1;
        } else if mode != super::ProfilingMode::Off {
            match row.disposition.as_str() {
                "complete" => counts.processed += 1,
                "pending" => counts.pending += 1,
                "failed" => counts.failed += 1,
                _ => {}
            }
        }
    }
    Some(counts)
}

/// Whether the row's byte range still exists in the user's own text.
fn still_current(row: &CoverageRow, message: &super::CanonicalProfileMessage) -> bool {
    if message.role != "user" || message.origin_kind != "user_input" {
        return false;
    }
    let scalar = message
        .parts
        .iter()
        .find(|part| part.part_id == row.part_id)
        .and_then(|part| {
            part.scalars.iter().find(|scalar| {
                scalar.pointer == row.pointer && scalar.source_hash == row.source_hash
            })
        });
    scalar.is_some_and(|scalar| {
        row.byte_start >= 0
            && row.byte_end > row.byte_start
            && row.byte_end <= i64::try_from(scalar.text.len()).unwrap_or(i64::MAX)
    })
}

fn unavailable(reason: &'static str) -> ProfileCoverageHealth {
    ProfileCoverageHealth {
        available: false,
        reason: Some(reason),
        consent_mode: "off",
        processed_windows: 0,
        pending_windows: 0,
        failed_windows: 0,
        stale_history_windows: 0,
        historical_processed_windows: 0,
        discovery_incomplete: None,
        discovery_reason: Some("discovery_not_observed"),
    }
}
