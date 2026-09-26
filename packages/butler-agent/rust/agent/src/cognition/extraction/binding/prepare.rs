use super::*;

struct Requested {
    local_ref: String,
    cue: String,
    meaning: Value,
    evidence: Vec<f64>,
    change: bool,
    old: Option<String>,
    new_value: Option<String>,
}

pub(in crate::cognition) async fn prepare(
    meaning: &Meaning,
    passages: &[Passage],
    search: &dyn CognitionCandidateSearch,
    base: &CandidateSearchInput<'_>,
) -> CognitionResult<(Vec<BindingBatch>, Vec<ExtractCandidate>)> {
    let mut targets = Vec::new();
    for (index, entity) in meaning.entities.iter().enumerate() {
        targets.push(Requested {
            local_ref: format!("n{index}"),
            cue: entity.name.clone(),
            meaning: json!({"name":entity.name}),
            evidence: entity.evidence.clone(),
            change: false,
            old: None,
            new_value: None,
        });
    }
    for (index, item) in meaning.items.iter().enumerate() {
        if item.get("kind").and_then(Value::as_str) != Some("change") {
            continue;
        }
        let subject = item
            .get("subject")
            .and_then(Value::as_u64)
            .and_then(|i| {
                meaning
                    .entities
                    .get(usize::try_from(i).unwrap_or(usize::MAX))
            })
            .map(|e| e.name.as_str())
            .unwrap_or("");
        let cue = [
            subject,
            item.get("field").and_then(Value::as_str).unwrap_or(""),
            item.get("old").and_then(Value::as_str).unwrap_or(""),
            item.get("new").and_then(Value::as_str).unwrap_or(""),
        ]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
        targets.push(Requested {
            local_ref: format!("f{index}"),
            cue,
            meaning: serde_json::to_value(item).map_err(json_error)?,
            evidence: item
                .get("evidence")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_f64)
                .collect(),
            change: true,
            old: item.get("old").and_then(Value::as_str).map(str::to_owned),
            new_value: item.get("new").and_then(Value::as_str).map(str::to_owned),
        });
    }
    let mut batches = Vec::new();
    let mut batch = BindingBatch {
        prompt: json!({"targets":[],"evidence":[]}),
        targets: Vec::new(),
        quotes: HashMap::new(),
    };
    let mut all = Vec::new();
    let mut all_seen = HashSet::new();
    for target in targets {
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
        let eligible = loaded
            .into_iter()
            .filter(|candidate| {
                if target.change {
                    candidate.node_type != "entity" && candidate.node_type != "project"
                } else {
                    candidate.node_type == "entity" || candidate.node_type == "project"
                }
            })
            .take(3)
            .collect::<Vec<_>>();
        if eligible.is_empty() && !target.change {
            continue;
        }
        let mut candidate_map = HashMap::new();
        let mut span_map = HashMap::new();
        let mut quotes = HashMap::new();
        let mut current_refs = HashSet::new();
        let mut evidence = Vec::new();
        for id in &target.evidence {
            let passage = passages
                .get(crate::json::saturating_usize(*id))
                .ok_or_else(|| error("memory_extract_invalid_ref"))?;
            let reference = format!("{}u{id}", target.local_ref);
            current_refs.insert(reference.clone());
            quotes.insert(reference.clone(), passage.quote.clone());
            evidence.push(json!({"ref":reference,"text":passage.quote.quote,"role":"current"}));
        }
        let mut wire_candidates = Vec::new();
        let mut historical_refs = HashMap::new();
        for (index, candidate) in eligible.into_iter().enumerate() {
            let Some((quote, role)) = historical_quote(&candidate) else {
                continue;
            };
            let reference = format!("{}c{index}", target.local_ref);
            let historical = format!("{reference}h");
            candidate_map.insert(reference.clone(), candidate.clone());
            historical_refs.insert(reference.clone(), HashSet::from([historical.clone()]));
            quotes.insert(historical.clone(), quote.clone());
            evidence.push(json!({"ref":historical,"text":quote.quote,"role":role}));
            let statement = candidate
                .claim
                .as_ref()
                .and_then(|c| c.get("statement"))
                .and_then(Value::as_str)
                .unwrap_or(&candidate.label);
            let mut spans = Vec::new();
            if target.change
                && let Some(old) = target.old.as_deref().filter(|s| !s.is_empty())
            {
                for (start, _) in statement.match_indices(old) {
                    let end = start + old.len();
                    let span_ref = format!("{reference}p{}", spans.len());
                    span_map.insert(
                        span_ref.clone(),
                        Span {
                            candidate: reference.clone(),
                            start,
                            end,
                            value: target.new_value.clone().unwrap_or_default(),
                        },
                    );
                    let before = statement[..start]
                        .chars()
                        .rev()
                        .take(48)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect::<String>();
                    let after = statement[end..].chars().take(48).collect::<String>();
                    spans.push(json!({"ref":span_ref,"before":before,"value":old,"after":after}));
                }
            }
            let mut wire = json!({"ref":reference,"type":candidate.node_type,"label":statement,"evidence":[historical]});
            if target.change {
                wire["spans"] = json!(spans);
            }
            wire_candidates.push(wire);
        }
        if wire_candidates.is_empty() && !target.change {
            continue;
        }
        let current = evidence
            .iter()
            .filter(|v| v["role"] == "current")
            .map(|v| v["ref"].clone())
            .collect::<Vec<_>>();
        let entry = json!({"target":target.local_ref,"meaning":target.meaning,"evidence":current,"candidates":wire_candidates});
        if crate::json::stringify(&json!({"targets":[entry.clone()],"evidence":evidence}))
            .map_err(json_error)?
            .len()
            > 3072
        {
            return Err(error("memory_extract_binding_oversize"));
        }
        let mut proposed = batch.prompt.clone();
        append_to_prompt(&mut proposed, entry.clone(), evidence.clone());
        if batch.targets.len() == 4
            || crate::json::stringify(&proposed).map_err(json_error)?.len() > 3072
        {
            batches.push(batch);
            batch = BindingBatch {
                prompt: json!({"targets":[],"evidence":[]}),
                targets: Vec::new(),
                quotes: HashMap::new(),
            };
        }
        append_to_prompt(&mut batch.prompt, entry, evidence);
        batch.targets.push(Target {
            local_ref: target.local_ref,
            candidates: candidate_map,
            current_refs,
            historical_refs,
            spans: span_map,
            change: target.change,
        });
        batch.quotes.extend(quotes);
    }
    if !batch.targets.is_empty() {
        batches.push(batch);
    }
    Ok((batches, all))
}

/// Appends a target and its evidence to a `{"targets":[],"evidence":[]}` prompt.
fn append_to_prompt(prompt: &mut Value, entry: Value, evidence: Vec<Value>) {
    if let Some(targets) = prompt.get_mut("targets").and_then(Value::as_array_mut) {
        targets.push(entry);
    }
    if let Some(items) = prompt.get_mut("evidence").and_then(Value::as_array_mut) {
        items.extend(evidence);
    }
}
