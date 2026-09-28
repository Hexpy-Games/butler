//! KnowHow entry files: the stored document (`butler.cognition.knowhow.v1`).
//!
//! Every field is declared in the stored order and keeps a missing key, an
//! explicit `null` or a value of another type exactly as stored, so a
//! revision rewrites only the fields it changes; keys the schema does not
//! name follow the known fields of their object.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

use super::error;
use crate::cognition::{CognitionCode, CognitionResult, FeedbackTarget};
use crate::lenient::{Arg, Obj};

/// A stored know-how entry.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
pub(super) struct KnowHowDocument {
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub schema: Arg<String>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub knowhow_id: Arg<String>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub name: Arg<String>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub aliases: Arg<Vec<Arg<String>>>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub status: Arg<KnowHowStatus>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub scope: Arg<String>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    created_at: Arg<String>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub updated_at: Arg<String>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub summary: Arg<String>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub intent_match: Arg<Obj<IntentMatch>>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    preconditions: Arg<Vec<Arg<String>>>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub strategy: Arg<Obj<Strategy>>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    freshness: Arg<Obj<Freshness>>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    fallback: Arg<Obj<Fallback>>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub quality: Arg<Obj<Quality>>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    refs: Arg<Obj<Refs>>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    revision_history: Arg<Vec<Arg<Obj<RevisionEvent>>>>,
    /// Passthrough: keys the entry schema does not name, kept on rewrite.
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// An entry's lifecycle; a status this version does not know is kept as
/// written and fails validation.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(from = "String", into = "String")]
pub(super) enum KnowHowStatus {
    /// Proposed, not yet trusted.
    Candidate,
    /// In use.
    Active,
    /// Hidden by feedback.
    Suppressed,
    /// Waiting for review after negative feedback.
    NeedsReview,
    /// Turned off.
    Disabled,
    /// Removed from use for good.
    Forgotten,
    /// A status this version does not know.
    Other(String),
}

impl KnowHowStatus {
    /// The stored status text.
    pub(super) fn as_str(&self) -> &str {
        match self {
            Self::Candidate => "candidate",
            Self::Active => "active",
            Self::Suppressed => "suppressed",
            Self::NeedsReview => "needs_review",
            Self::Disabled => "disabled",
            Self::Forgotten => "forgotten",
            Self::Other(status) => status,
        }
    }

    /// Whether the status is one of the schema's statuses.
    pub(super) fn is_known(&self) -> bool {
        !matches!(self, Self::Other(_))
    }
}

impl From<String> for KnowHowStatus {
    fn from(status: String) -> Self {
        match status.as_str() {
            "candidate" => Self::Candidate,
            "active" => Self::Active,
            "suppressed" => Self::Suppressed,
            "needs_review" => Self::NeedsReview,
            "disabled" => Self::Disabled,
            "forgotten" => Self::Forgotten,
            _ => Self::Other(status),
        }
    }
}

impl From<KnowHowStatus> for String {
    fn from(status: KnowHowStatus) -> Self {
        match status {
            KnowHowStatus::Other(status) => status,
            known => known.as_str().to_owned(),
        }
    }
}

/// When an entry applies.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
pub(super) struct IntentMatch {
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub topics: Arg<Vec<Arg<String>>>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub examples: Arg<Vec<Arg<String>>>,
    /// Passthrough: keys the entry schema does not name.
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// How an entry says to work.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
pub(super) struct Strategy {
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    steps: Arg<Vec<Arg<String>>>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub preferred_sources: Arg<Vec<Arg<String>>>,
    /// Passthrough: keys the entry schema does not name.
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// How fresh a source must be.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
struct Freshness {
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    max_age_minutes: Arg<Number>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    requires_source_timestamp: Arg<bool>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    fallback_when_stale: Arg<String>,
    /// Passthrough: keys the entry schema does not name.
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// What to do when the entry cannot be used.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
struct Fallback {
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    when_unavailable: Arg<String>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    when_negative_feedback: Arg<String>,
    /// Passthrough: keys the entry schema does not name.
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// An entry's quality bookkeeping. Numbers keep their stored form.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
pub(super) struct Quality {
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub score: Arg<Number>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub confidence: Arg<Number>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    success_count: Arg<Number>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    failure_count: Arg<Number>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    negative_feedback_count: Arg<Number>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    last_used_at: Arg<String>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    last_validated_at: Arg<String>,
    /// Passthrough: keys the entry schema does not name.
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// Records the entry was derived from or revised by.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
struct Refs {
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    box_item_ids: Arg<Vec<Arg<String>>>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    memory_chunk_ids: Arg<Vec<Arg<String>>>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    feedback_ids: Arg<Vec<Arg<String>>>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    consolidation_run_ids: Arg<Vec<Arg<String>>>,
    /// Passthrough: keys the entry schema does not name.
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// One `revision_history` event.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
struct RevisionEvent {
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    at: Arg<String>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    kind: Arg<RevisionKind>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    feedback_ids: Arg<Vec<Arg<String>>>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    previous_status: Arg<KnowHowStatus>,
    /// Passthrough: keys the event schema does not name.
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// Why an entry was revised.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum RevisionKind {
    /// Routed feedback changed the entry.
    FeedbackRevision,
    /// An operator disabled the entry.
    OperatorDisable,
}

impl KnowHowDocument {
    /// A required string field.
    pub(super) fn required(field: &Arg<String>) -> CognitionResult<&str> {
        field.valid().map(String::as_str).ok_or_else(invalid)
    }

    /// A required array of strings.
    pub(super) fn strings(field: &Arg<Vec<Arg<String>>>) -> CognitionResult<Vec<&str>> {
        field
            .valid()
            .ok_or_else(invalid)?
            .iter()
            .map(Self::required)
            .collect()
    }

    /// The required status.
    pub(super) fn required_status(&self) -> CognitionResult<&KnowHowStatus> {
        self.status.valid().ok_or_else(invalid)
    }

    /// The strategy's preferred sources (every item a string).
    pub(super) fn preferred_sources(&self) -> CognitionResult<Vec<&str>> {
        let Arg::Valid(Obj(strategy)) = &self.strategy else {
            return Err(invalid());
        };
        Self::strings(&strategy.preferred_sources)
    }

    /// The quality block.
    pub(super) fn quality(&self) -> CognitionResult<&Quality> {
        match &self.quality {
            Arg::Valid(Obj(quality)) => Ok(quality),
            _ => Err(invalid()),
        }
    }

    /// The document as the operator API returns it.
    pub(super) fn to_value(&self) -> CognitionResult<Value> {
        serde_json::to_value(self).map_err(|source| invalid().with_source(source))
    }

    /// Sets `status` and `updated_at`.
    pub(super) fn set_status(&mut self, status: KnowHowStatus, now: &str) {
        self.status = Arg::Valid(status);
        self.updated_at = Arg::Valid(now.to_owned());
    }

    /// Lowers the quality score by 0.25 (not below 0), counts the feedback,
    /// and references each feedback id once.
    pub(super) fn record_negative_feedback(
        &mut self,
        targeted: &[FeedbackTarget],
    ) -> CognitionResult<()> {
        let Arg::Valid(Obj(quality)) = &mut self.quality else {
            return Err(invalid());
        };
        let score = quality
            .score
            .valid()
            .and_then(Number::as_f64)
            .ok_or_else(invalid)?;
        let score = Number::from_f64(round3((score - 0.25).max(0.0))).ok_or_else(invalid)?;
        quality.score = Arg::Valid(score);
        let count = quality
            .negative_feedback_count
            .valid()
            .and_then(Number::as_u64)
            .ok_or_else(invalid)?;
        quality.negative_feedback_count =
            Arg::Valid(count.saturating_add(targeted.len() as u64).into());
        let Arg::Valid(Obj(refs)) = &mut self.refs else {
            return Err(invalid());
        };
        let Arg::Valid(feedback_ids) = &mut refs.feedback_ids else {
            return Err(invalid());
        };
        for feedback in targeted {
            if !feedback_ids
                .iter()
                .any(|id| id.valid() == Some(&feedback.feedback_id))
            {
                feedback_ids.push(Arg::Valid(feedback.feedback_id.clone()));
            }
        }
        Ok(())
    }

    /// Appends a `revision_history` event.
    pub(super) fn push_history(
        &mut self,
        kind: RevisionKind,
        feedback: Option<&[FeedbackTarget]>,
        previous_status: KnowHowStatus,
        at: String,
    ) -> CognitionResult<()> {
        let Arg::Valid(history) = &mut self.revision_history else {
            return Err(invalid());
        };
        history.push(Arg::Valid(Obj(RevisionEvent {
            at: Arg::Valid(at),
            kind: Arg::Valid(kind),
            feedback_ids: feedback.map_or(Arg::Missing, |targeted| {
                Arg::Valid(
                    targeted
                        .iter()
                        .map(|feedback| Arg::Valid(feedback.feedback_id.clone()))
                        .collect(),
                )
            }),
            previous_status: Arg::Valid(previous_status),
            extra: Map::new(),
        })));
        Ok(())
    }
}

fn invalid() -> crate::cognition::CognitionError {
    error(CognitionCode::MemoryKnowhowEntryInvalid)
}

pub(super) fn round3(value: f64) -> f64 {
    (value * 1_000.0).round() / 1_000.0
}
