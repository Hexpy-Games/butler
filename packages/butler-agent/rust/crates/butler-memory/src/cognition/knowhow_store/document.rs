//! KnowHow entry files: the stored document and its typed view.
//!
//! An entry file is kept verbatim as a [`KnowHowDocument`] so that a revision
//! rewrites only the fields it changes (in place, keeping key order and
//! unknown fields); everything the store reads goes through the lenient
//! [`KnowHowEntry`] view.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::error;
use crate::cognition::{CognitionCode, CognitionResult, FeedbackTarget};
use crate::lenient::{Arg, Obj};

/// A stored entry file. Passthrough: the document is rewritten verbatim
/// except for the fields a revision sets, so it is not interpreted here.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub(super) struct KnowHowDocument(Value);

/// The fields of an entry the store reads; each keeps whether it was
/// missing, `null`, readable or of another type.
#[derive(Debug, Default, Deserialize)]
pub(super) struct KnowHowEntry {
    #[serde(default)]
    pub schema: Arg<String>,
    #[serde(default)]
    pub knowhow_id: Arg<String>,
    #[serde(default)]
    pub name: Arg<String>,
    #[serde(default)]
    pub status: Arg<String>,
    #[serde(default)]
    pub scope: Arg<String>,
    #[serde(default)]
    pub summary: Arg<String>,
    #[serde(default)]
    pub updated_at: Arg<String>,
    #[serde(default)]
    pub aliases: Arg<Vec<Arg<String>>>,
    #[serde(default)]
    pub intent_match: Arg<Obj<IntentMatch>>,
    #[serde(default)]
    pub strategy: Arg<Obj<Strategy>>,
    #[serde(default)]
    pub quality: Arg<Obj<Quality>>,
}

/// When an entry applies.
#[derive(Debug, Default, Deserialize)]
pub(super) struct IntentMatch {
    #[serde(default)]
    pub topics: Arg<Vec<Arg<String>>>,
    #[serde(default)]
    pub examples: Arg<Vec<Arg<String>>>,
}

/// How an entry says to work.
#[derive(Debug, Default, Deserialize)]
pub(super) struct Strategy {
    #[serde(default)]
    pub preferred_sources: Arg<Vec<Arg<String>>>,
}

/// An entry's quality bookkeeping.
#[derive(Debug, Default, Deserialize)]
pub(super) struct Quality {
    #[serde(default)]
    pub score: Arg<f64>,
    #[serde(default)]
    pub confidence: Arg<f64>,
}

/// One `revision_history` event.
#[derive(Serialize)]
struct RevisionEvent<'a> {
    at: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    feedback_ids: Option<Vec<&'a str>>,
    previous_status: &'a str,
}

impl KnowHowEntry {
    /// A required string field.
    pub(super) fn required(field: &Arg<String>) -> CognitionResult<&str> {
        field
            .valid()
            .map(String::as_str)
            .ok_or_else(|| error(CognitionCode::MemoryKnowhowEntryInvalid))
    }

    /// A required array of strings.
    pub(super) fn strings(field: &Arg<Vec<Arg<String>>>) -> CognitionResult<Vec<&str>> {
        field
            .valid()
            .ok_or_else(|| error(CognitionCode::MemoryKnowhowEntryInvalid))?
            .iter()
            .map(Self::required)
            .collect()
    }

    /// The strategy's preferred sources (every item a string).
    pub(super) fn preferred_sources(&self) -> CognitionResult<Vec<&str>> {
        let Arg::Valid(Obj(strategy)) = &self.strategy else {
            return Err(error(CognitionCode::MemoryKnowhowEntryInvalid));
        };
        Self::strings(&strategy.preferred_sources)
    }

    /// The quality block.
    pub(super) fn quality(&self) -> CognitionResult<&Quality> {
        match &self.quality {
            Arg::Valid(Obj(quality)) => Ok(quality),
            _ => Err(error(CognitionCode::MemoryKnowhowEntryInvalid)),
        }
    }
}

impl KnowHowDocument {
    pub(super) fn new(document: Value) -> Self {
        Self(document)
    }

    /// The typed view of the document.
    pub(super) fn entry(&self) -> KnowHowEntry {
        crate::lenient::view(&self.0)
    }

    /// The document as the operator API returns it.
    pub(super) fn into_value(self) -> Value {
        self.0
    }

    /// Sets `status` and `updated_at`.
    pub(super) fn set_status(&mut self, status: &str, now: &str) -> CognitionResult<()> {
        let fields = self.fields()?;
        fields.insert("status".into(), Value::String(status.into()));
        fields.insert("updated_at".into(), Value::String(now.into()));
        Ok(())
    }

    /// Lowers the quality score by 0.25 (not below 0), counts the feedback,
    /// and references each feedback id once.
    pub(super) fn record_negative_feedback(
        &mut self,
        targeted: &[FeedbackTarget],
    ) -> CognitionResult<()> {
        let quality = object(self.fields()?.get_mut("quality"))?;
        let score = quality
            .get("score")
            .and_then(Value::as_f64)
            .ok_or_else(invalid)?;
        quality.insert("score".into(), Value::from(round3((score - 0.25).max(0.0))));
        let count = quality
            .get("negative_feedback_count")
            .and_then(Value::as_u64)
            .ok_or_else(invalid)?;
        quality.insert(
            "negative_feedback_count".into(),
            Value::from(count.saturating_add(targeted.len() as u64)),
        );
        let refs = object(self.fields()?.get_mut("refs"))?;
        let feedback_ids = refs
            .get_mut("feedback_ids")
            .and_then(Value::as_array_mut)
            .ok_or_else(invalid)?;
        for feedback in targeted {
            let id = Value::String(feedback.feedback_id.clone());
            if !feedback_ids.contains(&id) {
                feedback_ids.push(id);
            }
        }
        Ok(())
    }

    /// Appends a `revision_history` event.
    pub(super) fn push_history(
        &mut self,
        kind: &'static str,
        feedback: Option<&[FeedbackTarget]>,
        previous_status: &str,
        at: String,
    ) -> CognitionResult<()> {
        let event = RevisionEvent {
            at,
            kind,
            feedback_ids: feedback.map(|targeted| {
                targeted
                    .iter()
                    .map(|feedback| feedback.feedback_id.as_str())
                    .collect()
            }),
            previous_status,
        };
        let event = serde_json::to_value(event).map_err(|source| invalid().with_source(source))?;
        self.fields()?
            .get_mut("revision_history")
            .and_then(Value::as_array_mut)
            .ok_or_else(invalid)?
            .push(event);
        Ok(())
    }

    fn fields(&mut self) -> CognitionResult<&mut Map<String, Value>> {
        self.0.as_object_mut().ok_or_else(invalid)
    }
}

fn object(value: Option<&mut Value>) -> CognitionResult<&mut Map<String, Value>> {
    value.and_then(Value::as_object_mut).ok_or_else(invalid)
}

fn invalid() -> crate::cognition::CognitionError {
    error(CognitionCode::MemoryKnowhowEntryInvalid)
}

pub(super) fn round3(value: f64) -> f64 {
    (value * 1_000.0).round() / 1_000.0
}
