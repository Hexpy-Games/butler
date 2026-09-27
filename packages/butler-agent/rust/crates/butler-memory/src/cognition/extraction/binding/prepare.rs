//! Binding preparation: which targets to bind, their candidates and quoted
//! evidence, packed into prompt batches of at most 4 targets and 3 KiB.

use super::*;
use crate::cognition::CognitionCode;
use crate::cognition::extraction::meaning::MeaningItem;

/// Prompt budget of one binding call, in `JSON.stringify` bytes.
const BATCH_BUDGET_BYTES: usize = 3072;
/// Targets per binding call.
const BATCH_TARGETS: usize = 4;

/// A meaning entity or change that asks to be bound.
struct Requested {
    local_ref: String,
    cue: String,
    meaning: TargetMeaning,
    evidence: Vec<usize>,
    change: Option<ChangeValues>,
}

/// The old and new value of a change target.
struct ChangeValues {
    old: Option<String>,
    new_value: String,
}

/// A target with its searched candidates, ready to be batched.
struct Offer {
    entry: PromptTarget,
    evidence: Vec<PromptEvidence>,
    target: Target,
    quotes: HashMap<String, QuoteRef>,
}

/// Searches candidates for every entity and change of `meaning` and packs
/// the targets that have any into batches. Also returns every candidate
/// loaded, which the pinned input records.
pub(in crate::cognition) async fn prepare(
    meaning: &Meaning,
    passages: &[Passage],
    search: &dyn CognitionCandidateSearch,
    base: &CandidateSearchInput<'_>,
) -> CognitionResult<(Vec<BindingBatch>, Vec<ExtractCandidate>)> {
    let mut batches = Vec::new();
    let mut batch = empty_batch();
    let mut all = Vec::new();
    let mut all_seen = HashSet::new();
    for target in requested(meaning) {
        let loaded = search
            .search(CandidateSearchInput {
                source_root: base.source_root,
                generation_id: base.generation_id,
                embedding: base.embedding,
                cue: &target.cue,
                bound_project_id: base.bound_project_id,
                deadline_epoch_millis: base.deadline_epoch_millis,
            })
            .await?;
        for candidate in &loaded {
            if all_seen.insert(candidate.ref_id.clone()) {
                all.push(candidate.clone());
            }
        }
        let Some(offer) = offer(target, loaded, passages)? else {
            continue;
        };
        if let Some(full) = add_to_batch(&mut batch, offer)? {
            batches.push(full);
        }
    }
    if !batch.targets.is_empty() {
        batches.push(batch);
    }
    Ok((batches, all))
}

/// Entities `n{i}` (cue: the name) and changes `f{i}` (cue: subject name,
/// field, old and new value).
fn requested(meaning: &Meaning) -> Vec<Requested> {
    let entities = meaning
        .entities
        .iter()
        .enumerate()
        .map(|(index, entity)| Requested {
            local_ref: format!("n{index}"),
            cue: entity.name.clone(),
            meaning: TargetMeaning::Entity {
                name: entity.name.clone(),
            },
            evidence: entity.evidence.clone(),
            change: None,
        });
    let changes = meaning
        .items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| match item {
            MeaningItem::Change(change) => Some((index, change)),
            _ => None,
        })
        .map(|(index, change)| {
            let subject = change
                .subject
                .and_then(|i| meaning.entities.get(i))
                .map_or("", |e| e.name.as_str());
            let cue = [
                subject,
                change.field.as_str(),
                change.old.as_deref().unwrap_or(""),
                change.new.as_str(),
            ]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
            Requested {
                local_ref: format!("f{index}"),
                cue,
                meaning: TargetMeaning::Item(TaggedItem::Change(change.clone())),
                evidence: change.evidence.clone(),
                change: Some(ChangeValues {
                    old: change.old.clone(),
                    new_value: change.new.clone(),
                }),
            }
        });
    entities.chain(changes).collect()
}

/// The target's offer: up to 3 eligible candidates (identity nodes for an
/// entity, claims for a change) that can quote themselves. `None` when an
/// entity has nothing to bind to; a change is always offered.
fn offer(
    target: Requested,
    loaded: Vec<ExtractCandidate>,
    passages: &[Passage],
) -> CognitionResult<Option<Offer>> {
    let change = target.change.is_some();
    let eligible = loaded
        .into_iter()
        .filter(|candidate| candidate.is_identity_node() != change)
        .take(3)
        .collect::<Vec<_>>();
    if eligible.is_empty() && !change {
        return Ok(None);
    }
    let mut quotes = HashMap::new();
    let mut current_refs = HashSet::new();
    let mut evidence = Vec::new();
    for id in &target.evidence {
        let passage = passages
            .get(*id)
            .ok_or_else(|| error(CognitionCode::MemoryExtractInvalidRef))?;
        let reference = format!("{}u{id}", target.local_ref);
        current_refs.insert(reference.clone());
        quotes.insert(reference.clone(), passage.quote.clone());
        evidence.push(PromptEvidence {
            reference,
            text: passage.quote.quote.clone(),
            role: "current".into(),
        });
    }
    let mut offered = Offered::default();
    for (index, candidate) in eligible.into_iter().enumerate() {
        let reference = format!("{}c{index}", target.local_ref);
        offered.add(&target, reference, candidate, &mut quotes, &mut evidence);
    }
    if offered.wire.is_empty() && !change {
        return Ok(None);
    }
    let current = evidence
        .iter()
        .filter(|item| item.role == "current")
        .map(|item| item.reference.clone())
        .collect();
    Ok(Some(Offer {
        entry: PromptTarget {
            target: target.local_ref.clone(),
            meaning: target.meaning,
            evidence: current,
            candidates: offered.wire,
        },
        evidence,
        target: Target {
            local_ref: target.local_ref,
            candidates: offered.candidates,
            current_refs,
            historical_refs: offered.historical_refs,
            spans: offered.spans,
            change,
        },
        quotes,
    }))
}

/// Candidates accepted into one offer, in prompt and lookup form.
#[derive(Default)]
struct Offered {
    wire: Vec<PromptCandidate>,
    candidates: HashMap<String, ExtractCandidate>,
    historical_refs: HashMap<String, HashSet<String>>,
    spans: HashMap<String, Span>,
}

impl Offered {
    /// Adds `candidate` as `reference` with its historical quote `{ref}h`;
    /// a candidate that cannot quote itself is skipped.
    fn add(
        &mut self,
        target: &Requested,
        reference: String,
        candidate: ExtractCandidate,
        quotes: &mut HashMap<String, QuoteRef>,
        evidence: &mut Vec<PromptEvidence>,
    ) {
        let Some((quote, role)) = historical_quote(&candidate) else {
            return;
        };
        let historical = format!("{reference}h");
        evidence.push(PromptEvidence {
            reference: historical.clone(),
            text: quote.quote.clone(),
            role,
        });
        quotes.insert(historical.clone(), quote);
        self.historical_refs
            .insert(reference.clone(), HashSet::from([historical.clone()]));
        let statement = candidate
            .claim
            .as_ref()
            .map_or(candidate.label.as_str(), |claim| claim.statement.as_str());
        let spans = target
            .change
            .as_ref()
            .map(|change| self.spans(&reference, statement, change));
        self.wire.push(PromptCandidate {
            reference: reference.clone(),
            node_type: candidate.node_type.clone(),
            label: statement.to_owned(),
            evidence: vec![historical],
            spans,
        });
        self.candidates.insert(reference, candidate);
    }

    /// Every occurrence of the change's old value in `statement`, shown with
    /// 48 characters of context on each side.
    fn spans(
        &mut self,
        reference: &str,
        statement: &str,
        change: &ChangeValues,
    ) -> Vec<PromptSpan> {
        let Some(old) = change.old.as_deref().filter(|s| !s.is_empty()) else {
            return Vec::new();
        };
        let mut spans = Vec::new();
        for (start, _) in statement.match_indices(old) {
            let end = start + old.len();
            let span_ref = format!("{reference}p{}", spans.len());
            self.spans.insert(
                span_ref.clone(),
                Span {
                    candidate: reference.to_owned(),
                    start,
                    end,
                    value: change.new_value.clone(),
                },
            );
            let before = statement.get(..start).unwrap_or_default();
            let before = before
                .chars()
                .rev()
                .take(48)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>();
            let after = statement.get(end..).unwrap_or_default();
            spans.push(PromptSpan {
                reference: span_ref,
                before,
                value: old.to_owned(),
                after: after.chars().take(48).collect(),
            });
        }
        spans
    }
}

/// Adds the offer to `batch`; when the batch is full (4 targets or over
/// budget with it) the previous batch is returned and a new one started.
/// A single target over budget is an error.
fn add_to_batch(batch: &mut BindingBatch, offer: Offer) -> CognitionResult<Option<BindingBatch>> {
    let alone = BindingPrompt {
        targets: vec![offer.entry.clone()],
        evidence: offer.evidence.clone(),
    };
    if bytes(&alone)? > BATCH_BUDGET_BYTES {
        return Err(error(CognitionCode::MemoryExtractBindingOversize));
    }
    let mut proposed = batch.prompt.clone();
    proposed.targets.push(offer.entry.clone());
    proposed.evidence.extend(offer.evidence.iter().cloned());
    let full = if batch.targets.len() == BATCH_TARGETS || bytes(&proposed)? > BATCH_BUDGET_BYTES {
        Some(std::mem::replace(batch, empty_batch()))
    } else {
        None
    };
    batch.prompt.targets.push(offer.entry);
    batch.prompt.evidence.extend(offer.evidence);
    batch.targets.push(offer.target);
    batch.quotes.extend(offer.quotes);
    Ok(full)
}

fn empty_batch() -> BindingBatch {
    BindingBatch {
        prompt: BindingPrompt::default(),
        targets: Vec::new(),
        quotes: HashMap::new(),
    }
}

fn bytes(prompt: &BindingPrompt) -> CognitionResult<usize> {
    Ok(crate::js_json::stringify(prompt)
        .map_err(json_error)?
        .len())
}
