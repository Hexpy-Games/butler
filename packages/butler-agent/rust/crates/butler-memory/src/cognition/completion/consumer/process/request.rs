//! Lenient queue wire records and dead-letter serialization.
use crate::lenient::{Arg, Obj};
use serde::{Deserialize, Serialize};
use serde_json::Number;

/// The head of `queue/sync.jsonl`, read leniently: every field keeps what
/// was sent so mismatches and dead letters behave as on the raw request.
#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct SyncRequest {
    #[serde(default)]
    pub(super) schema_version: Arg<String>,
    #[serde(default)]
    pub(super) job_id: Arg<String>,
    #[serde(default)]
    pub(super) source: Arg<Obj<SyncSource>>,
}

/// The source a sync request asks to register.
#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct SyncSource {
    #[serde(default)]
    pub kind: Arg<String>,
    #[serde(default)]
    pub record_kind: Arg<String>,
    #[serde(default)]
    pub record_id: Arg<String>,
    #[serde(default)]
    pub revision: Arg<String>,
    #[serde(default)]
    pub operation_id: Arg<String>,
    #[serde(default)]
    pub session_id: Arg<String>,
    #[serde(default)]
    pub turn_id: Arg<String>,
    #[serde(default)]
    pub outcome_generation: Arg<Number>,
}

impl SyncRequest {
    /// The request's source; a source that is not an object reads as empty.
    pub(super) fn source(&self) -> &SyncSource {
        static EMPTY: SyncSource = SyncSource {
            kind: Arg::Missing,
            record_kind: Arg::Missing,
            record_id: Arg::Missing,
            revision: Arg::Missing,
            operation_id: Arg::Missing,
            session_id: Arg::Missing,
            turn_id: Arg::Missing,
            outcome_generation: Arg::Missing,
        };
        self.source.valid().map_or(&EMPTY, |Obj(source)| source)
    }
}

/// A `queue/dead-letter.jsonl` line.
#[derive(Serialize)]
pub(super) struct DeadLetter<'a> {
    pub(super) timestamp: &'a str,
    pub(super) session_id: &'a Arg<String>,
    pub(super) project: &'static str,
    pub(super) reason: &'a str,
    pub(super) exit_code: Option<u8>,
    pub(super) stderr_tail: &'a str,
}
