//! Source-compatible complete-bundle selection under the native 24 KiB envelope.

use std::cmp::Ordering;

use serde::Serialize;

use crate::cognition::recall::{RecallRequirement, RecallResultItem};
use crate::cognition::{CognitionError, CognitionResult};

pub(super) const MAX_BYTES: usize = 24 * 1024;

#[derive(Serialize)]
struct Envelope<'a, T: Serialize + ?Sized> {
    ok: bool,
    output: Output<'a, T>,
}

#[derive(Serialize)]
struct Output<'a, T: Serialize + ?Sized> {
    ok: bool,
    #[serde(flatten)]
    response: &'a T,
}

pub(super) fn bytes<T: Serialize + ?Sized>(response: &T) -> CognitionResult<usize> {
    crate::json::serde_serialized_bytes(&Envelope {
        ok: true,
        output: Output { ok: true, response },
    })
    .map_err(|_| CognitionError::new("serialization_budget", "serialization_budget"))
}

pub(super) fn minimum(
    result: &RecallResultItem,
    mut rebind: impl FnMut(
        Vec<crate::cognition::recall::RecallEvidence>,
    ) -> CognitionResult<Option<RecallResultItem>>,
    compare_locale: impl Fn(&str, &str) -> Ordering,
) -> CognitionResult<RecallResultItem> {
    let mut minimum = result.clone();
    for index in (1..result.evidence.len()).rev() {
        let evidence = minimum
            .evidence
            .iter()
            .enumerate()
            .filter(|(current, _)| *current != index)
            .map(|(_, item)| item.clone())
            .collect::<Vec<_>>();
        if let Some(candidate) = rebind(evidence)?
            && candidate.summary == result.summary
            && candidate.matched_node_ref == result.matched_node_ref
            && requirement_key(&candidate.requirements, &compare_locale)
                == requirement_key(&result.requirements, &compare_locale)
        {
            minimum = candidate;
        }
    }
    if minimum.requirements.is_empty() {
        for item in &mut minimum.evidence {
            item.excerpt = crate::segmentation::grapheme_segments(&item.excerpt)
                .take(120)
                .map(|segment| segment.text)
                .collect();
        }
    }
    Ok(minimum)
}

fn requirement_key(
    requirements: &[RecallRequirement],
    compare_locale: &impl Fn(&str, &str) -> Ordering,
) -> Vec<(String, String, crate::json::JsonDocument, String)> {
    let mut values = requirements
        .iter()
        .map(|item| {
            (
                item.node_ref.clone(),
                item.action.clone(),
                item.condition.clone(),
                item.basis.clone(),
            )
        })
        .collect::<Vec<_>>();
    values.sort_by(|a, b| compare_locale(&a.0, &b.0));
    values
}
