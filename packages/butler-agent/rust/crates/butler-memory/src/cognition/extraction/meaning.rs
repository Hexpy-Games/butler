//! Meaning stage: the model reads numbered passages of a source window and
//! names its entities, items (facts, relations, requirements, changes) and
//! attributes, all referring back by passage and entity index.
//!
//! Start at [`source_passages`] (window -> passages), then [`meaning_prompt`]
//! (passages -> prompt), [`validate_meaning`] (model JSON -> [`Meaning`]) and
//! [`meaning_to_output`] (`Meaning` -> graph facts).

mod output;
mod prompt;
mod validation;

pub(in crate::cognition) use output::meaning_to_output;
pub(in crate::cognition) use prompt::meaning_prompt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{ExtractInput, QuoteRef};
use crate::cognition::CognitionCode;
use crate::cognition::{CognitionError, CognitionResult};

/// The model's reading of a source window, typed after [`validate_meaning`]
/// checked it against the contract and the passage/entity bounds.
#[derive(Clone, Debug, Deserialize)]
pub(in crate::cognition) struct Meaning {
    pub status: MeaningStatus,
    pub entities: Vec<MeaningEntity>,
    pub items: Vec<MeaningItem>,
    pub attributes: Vec<MeaningAttribute>,
}

/// Whether the model could read the window at all.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(in crate::cognition) enum MeaningStatus {
    Processed,
    NeedsContext,
    Unsupported,
}

/// A named entity with the passages that mention it.
#[derive(Clone, Debug, Deserialize)]
pub(in crate::cognition) struct MeaningEntity {
    pub name: String,
    pub evidence: Vec<usize>,
}

/// One statement the window supports, tagged by its `kind`.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(in crate::cognition) enum MeaningItem {
    Fact(StatementItem),
    Preference(StatementItem),
    Goal(StatementItem),
    Decision(StatementItem),
    Question(StatementItem),
    Proposal(StatementItem),
    Request(StatementItem),
    Inference(StatementItem),
    Relation(RelationItem),
    NotRelation(RelationItem),
    Requires(RequiresItem),
    Change(ChangeItem),
}

/// A free-text statement, optionally about one entity.
#[derive(Clone, Debug, Deserialize)]
pub(in crate::cognition) struct StatementItem {
    pub subject: Option<usize>,
    pub text: String,
    pub evidence: Vec<usize>,
}

/// A predicate between two entities.
#[derive(Clone, Debug, Deserialize)]
pub(in crate::cognition) struct RelationItem {
    pub from: usize,
    pub predicate: RelationPredicate,
    pub to: usize,
    pub evidence: Vec<usize>,
}

/// The predicates a relation item may use.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(in crate::cognition) enum RelationPredicate {
    Likes,
    Dislikes,
    Decided,
    BelongsTo,
    DependsOn,
    RelatedTo,
}

impl RelationPredicate {
    /// The graph relation name.
    pub(in crate::cognition) fn as_str(self) -> &'static str {
        match self {
            Self::Likes => "likes",
            Self::Dislikes => "dislikes",
            Self::Decided => "decided",
            Self::BelongsTo => "belongs_to",
            Self::DependsOn => "depends_on",
            Self::RelatedTo => "related_to",
        }
    }
}

/// An action an entity needs, and the condition that makes it necessary.
#[derive(Clone, Debug, Deserialize)]
pub(in crate::cognition) struct RequiresItem {
    pub subject: usize,
    pub action: String,
    pub condition: MeaningCondition,
    pub evidence: Vec<usize>,
}

/// A stated change of an earlier value, bound to a past claim by the binding
/// stage. Serialized back into the binding prompt in the contract's key order.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(in crate::cognition) struct ChangeItem {
    pub subject: Option<usize>,
    pub field: String,
    pub old: Option<String>,
    pub new: String,
    pub evidence: Vec<usize>,
}

/// A requirement's condition with entity indexes; see
/// [`super::ClaimCondition`] for the graph form.
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub(in crate::cognition) enum MeaningCondition {
    Atom {
        subject: Option<usize>,
        state: String,
    },
    Not {
        not: Box<MeaningCondition>,
    },
    All {
        all: Vec<MeaningCondition>,
    },
    Any {
        any: Vec<MeaningCondition>,
    },
}

/// An annotation on an entity or item.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(in crate::cognition) enum MeaningAttribute {
    /// Another name of an entity.
    Alias {
        entity: usize,
        name: String,
        evidence: Vec<usize>,
    },
    /// The item is important (the contract allows only `"high"`).
    Importance { item: usize },
    /// When the item holds.
    Validity {
        item: usize,
        from: Option<String>,
        to: Option<String>,
    },
}

/// One numbered sentence group of a source unit, as shown to the model.
#[derive(Clone, Debug, Serialize)]
pub(in crate::cognition) struct Passage {
    pub id: usize,
    pub text: String,
    pub quote: QuoteRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
}

/// Splits every source unit into passages of at most 256 graphemes along
/// sentence boundaries; a passage with an adjacent excerpt quotes the excerpt.
pub(in crate::cognition) fn source_passages(input: &ExtractInput) -> CognitionResult<Vec<Passage>> {
    let mut passages = Vec::new();
    for unit in &input.source_units {
        let mut covered = 0usize;
        for sentence in butler_core::segmentation::sentence_segments(&unit.text) {
            let clusters =
                butler_core::segmentation::grapheme_segments(sentence.text).collect::<Vec<_>>();
            for group in clusters.chunks(256) {
                let start = sentence.start + group.first().map_or(0, |x| x.start);
                let end = sentence.start + group.last().map_or(0, |x| x.end);
                passages.push(passage(input, unit, passages.len(), start, end)?);
                covered = end;
            }
        }
        if covered != unit.text.len() {
            return Err(error(CognitionCode::MemoryExtractSourceCoverage));
        }
    }
    Ok(passages)
}

/// The passage `start..end` of `unit`, quoting the adjacent excerpt whose
/// focus is exactly this span when there is one.
fn passage(
    input: &ExtractInput,
    unit: &super::ProjectionSourceUnit,
    id: usize,
    start: usize,
    end: usize,
) -> CognitionResult<Passage> {
    let slice = |text: &str, range: std::ops::Range<usize>| {
        text.get(range)
            .map(str::to_owned)
            .ok_or_else(|| error(CognitionCode::MemoryExtractSourceCoverage))
    };
    let text = slice(&unit.text, start..end)?;
    let context = input.context_units.iter().find_map(|entry| {
        let span = entry.source_span.as_ref()?;
        (span.source_ref == unit.ref_id
            && span.focus_start == start as f64
            && span.focus_end == end as f64)
            .then_some((entry, span))
    });
    let Some((context, span)) = context else {
        let before = unit.text.get(..start).unwrap_or_default();
        return Ok(Passage {
            id,
            quote: QuoteRef {
                unit_ref: unit.ref_id.clone(),
                quote: text.clone(),
                occurrence: before.match_indices(text.as_str()).count(),
            },
            text,
            before: None,
            after: None,
        });
    };
    let prefix = butler_core::json::saturating_usize(span.prefix_bytes);
    let focus_end = prefix + text.len();
    Ok(Passage {
        id,
        quote: QuoteRef {
            unit_ref: context.ref_id.clone(),
            quote: context.text.clone(),
            occurrence: 0,
        },
        before: Some(slice(&context.text, 0..prefix)?),
        after: Some(slice(&context.text, focus_end..context.text.len())?),
        text,
    })
}

/// Checks the model's meaning JSON against the contract (key sets, kinds,
/// entity and passage bounds) and types it. The first violation's code is
/// sent back to the model on repair, so the checks run in a fixed order.
pub(in crate::cognition) fn validate_meaning(
    value: Value,
    passages: &[Passage],
) -> CognitionResult<Meaning> {
    validation::validate(value, passages)
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
fn json_error(error: impl std::error::Error + Send + Sync + 'static) -> CognitionError {
    CognitionError::new(CognitionCode::MemoryExtractInvalidJson, error.to_string())
        .with_source(error)
}
