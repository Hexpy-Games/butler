//! Correction targets: the stable entries the extractor may correct, offered
//! under opaque refs, with a revision that detects changes before commit.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::super::contracts::{CanonicalProfileSourceFactory, ProfileResult, ProfilingMode};
use super::super::{projection, storage};
use super::types::{CorrectionTarget, CorrectionTargets, PublicTarget};
use crate::lenient::Arg;

pub(super) fn read(
    root: &Path,
    sources: &dyn CanonicalProfileSourceFactory,
    mode: ProfilingMode,
    salt: &str,
    now_ms: i64,
) -> ProfileResult<CorrectionTargets> {
    let entries = projection::correction_entries(root, sources, mode, now_ms)?;
    let mut public = Vec::new();
    let mut private = HashMap::new();
    for (index, entry) in entries.into_iter().take(4).enumerate() {
        let entry_revision = revision(&entry);
        let digest = format!(
            "{:x}",
            Sha256::digest(format!("{salt}\0{}", entry.id).as_bytes())
        );
        let reference = format!("profile_target:{}:{index}", digest.get(..16).unwrap_or(""));
        let understanding = &entry.understanding;
        let conditions = normalized_conditions(understanding.applies_when.clone());
        let facet = understanding.facet_text().map(str::to_owned);
        let instruction = understanding
            .butler_should
            .first()
            .cloned()
            .or_else(|| understanding.summary.valid().cloned())
            .unwrap_or_default();
        public.push(PublicTarget {
            target_ref: reference.clone(),
            instruction,
            category: entry.category.clone(),
            facet: facet.clone(),
            applies_when: conditions.clone(),
        });
        private.insert(
            reference,
            CorrectionTarget {
                stable_id: entry.id,
                category: entry.category,
                facet,
                applies_when: conditions,
                revision: entry_revision,
            },
        );
    }
    Ok(CorrectionTargets { public, private })
}

/// The fields of a stable entry a correction depends on, hashed to notice
/// a change between offering the target and committing the correction.
#[derive(Serialize)]
struct RevisionFields<'a> {
    id: &'a str,
    category: &'a str,
    facet: &'a Arg<String>,
    summary: &'a Arg<String>,
    applies_when: Vec<String>,
    butler_should: &'a [String],
    butler_should_not: &'a [String],
    evidence_refs: &'a [String],
    evidence_observed_at: &'a crate::profile::understanding::ObservedTimes,
    updated_at: &'a str,
}

pub(super) fn revision(entry: &storage::StoredEntry) -> String {
    let understanding = &entry.understanding;
    let missing_summary = Arg::Valid(String::new());
    let fields = RevisionFields {
        id: &entry.id,
        category: &entry.category,
        facet: &understanding.facet,
        summary: match understanding.summary {
            Arg::Missing => &missing_summary,
            _ => &understanding.summary,
        },
        applies_when: normalized_conditions(understanding.applies_when.clone()),
        butler_should: &understanding.butler_should,
        butler_should_not: &understanding.butler_should_not,
        evidence_refs: &understanding.evidence_refs,
        evidence_observed_at: &understanding.evidence_observed_at,
        updated_at: &entry.updated_at,
    };
    let text = serde_json::to_string(&fields).unwrap_or_default();
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

pub(super) fn normalized_conditions(mut values: Vec<String>) -> Vec<String> {
    values = values
        .into_iter()
        .map(|value| butler_core::public_text::trim_js_whitespace(&value).to_owned())
        .filter(|value| !value.is_empty())
        .collect();
    values.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    values.dedup();
    values
}
