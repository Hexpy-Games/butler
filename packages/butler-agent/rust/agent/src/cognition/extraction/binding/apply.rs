use super::*;
use crate::cognition::extraction::{ExtractCorrection, ExtractNode, ExtractRelation};

pub(in crate::cognition) fn apply(
    value: Value,
    batch: &BindingBatch,
    output: &mut ExtractOutput,
    input: &ExtractInput,
) -> CognitionResult<Vec<Value>> {
    let decisions = value
        .get("decisions")
        .and_then(Value::as_array)
        .ok_or_else(|| error("memory_extract_invalid_binding"))?;
    if decisions.len() != batch.targets.len() || decisions.len() > 4 {
        return Err(error("memory_extract_invalid_binding"));
    }
    let mut seen = HashSet::new();
    let mut warnings = Vec::new();
    for decision in decisions {
        let o = decision
            .as_object()
            .ok_or_else(|| error("memory_extract_invalid_binding"))?;
        if o.len() != 4
            || !["target", "candidate", "span", "support"]
                .iter()
                .all(|k| o.contains_key(*k))
        {
            return Err(error("memory_extract_invalid_binding"));
        }
        let reference = o["target"]
            .as_str()
            .ok_or_else(|| error("memory_extract_invalid_binding"))?;
        if !seen.insert(reference) {
            return Err(error("memory_extract_invalid_binding"));
        }
        let target = batch
            .targets
            .iter()
            .find(|t| t.local_ref == reference)
            .ok_or_else(|| error("memory_extract_invalid_ref"))?;
        let support = o["support"]
            .as_array()
            .ok_or_else(|| error("memory_extract_invalid_binding"))?;
        let refs = support
            .iter()
            .map(Value::as_str)
            .collect::<Option<Vec<_>>>()
            .filter(|refs| refs.len() <= 4)
            .ok_or_else(|| error("memory_extract_invalid_binding"))?;
        let span = o["span"].as_str();
        if !o["span"].is_null() && span.is_none() {
            return Err(error("memory_extract_invalid_binding"));
        }
        let Some(selected) = o["candidate"].as_str() else {
            if !o["candidate"].is_null() || span.is_some() || !refs.is_empty() {
                return Err(error("memory_extract_invalid_binding"));
            }
            if target.change {
                warnings.push(json!({"code":"correction_unresolved","target_ref":reference}));
            }
            continue;
        };
        let candidate = target
            .candidates
            .get(selected)
            .ok_or_else(|| error("memory_extract_invalid_identity_reuse"))?;
        let historical = target
            .historical_refs
            .get(selected)
            .ok_or_else(|| error("memory_extract_invalid_identity_reuse"))?;
        if !refs.iter().any(|r| target.current_refs.contains(*r))
            || !refs.iter().any(|r| historical.contains(*r))
            || refs
                .iter()
                .any(|r| !target.current_refs.contains(*r) && !historical.contains(*r))
        {
            return Err(error("memory_extract_invalid_identity_reuse"));
        }
        let evidence = refs
            .iter()
            .map(|r| {
                batch
                    .quotes
                    .get(*r)
                    .cloned()
                    .ok_or_else(|| error("memory_extract_invalid_identity_reuse"))
            })
            .collect::<CognitionResult<Vec<_>>>()?;
        if !target.change {
            if span.is_some()
                || !(candidate.node_type == "entity" || candidate.node_type == "project")
            {
                return Err(error("memory_extract_invalid_binding"));
            }
            let node = output
                .nodes
                .iter_mut()
                .find(|n| n.local_ref == reference)
                .ok_or_else(|| error("memory_extract_invalid_ref"))?;
            node.node_type = candidate.node_type.clone();
            node.resolution = NodeResolution::Reuse {
                node_ref: candidate.ref_id.clone(),
                reason: "named_context".into(),
                evidence,
            };
            continue;
        }
        if candidate.node_type == "entity" || candidate.node_type == "project" {
            return Err(error("memory_extract_invalid_binding"));
        }
        let chosen = span.and_then(|r| target.spans.get(r));
        if span.is_some() && chosen.is_none_or(|s| s.candidate != selected) {
            return Err(error("memory_extract_invalid_binding"));
        }
        let Some(chosen) = chosen else {
            warnings.push(json!({"code":"correction_unresolved","target_ref":reference}));
            continue;
        };
        let claim_index = output
            .claims
            .iter()
            .position(|c| c.local_ref == reference)
            .ok_or_else(|| error("memory_extract_invalid_ref"))?;
        let meta = candidate.claim.as_ref();
        let endpoint_refs = ["subject_ref", "object_ref"]
            .into_iter()
            .filter_map(|k| meta.and_then(|m| m.get(k)).and_then(Value::as_str))
            .collect::<Vec<_>>();
        let context_available =
            endpoint_refs.iter().all(|id| {
                output.nodes.iter().any(
                    |n| matches!(&n.resolution,NodeResolution::Reuse{node_ref,..} if node_ref==id),
                ) || input.candidates.iter().any(|n| {
                    n.ref_id == *id
                        && (n.node_type == "entity" || n.node_type == "project")
                        && historical_quote(n).is_some()
                })
            });
        let relation = meta.and_then(|m| m.get("relation")).and_then(Value::as_str);
        if !context_available || relation.is_some() && endpoint_refs.len() != 2 {
            warnings.push(json!({"code":"correction_context_unavailable","target_ref":reference}));
            continue;
        }
        let claim = &mut output.claims[claim_index];
        for quote in &evidence {
            if !claim.evidence.contains(quote) {
                claim.evidence.push(quote.clone())
            }
        }
        let previous = meta
            .and_then(|m| m.get("statement"))
            .and_then(Value::as_str)
            .unwrap_or(&candidate.label);
        if chosen.end > previous.len()
            || !previous.is_char_boundary(chosen.start)
            || !previous.is_char_boundary(chosen.end)
        {
            return Err(error("memory_extract_invalid_binding"));
        }
        claim.statement = format!(
            "{}{}{}",
            &previous[..chosen.start],
            chosen.value,
            &previous[chosen.end..]
        );
        claim.claim_type = candidate.node_type.clone();
        claim.condition = meta
            .and_then(|m| m.get("condition"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        claim.polarity = meta
            .and_then(|m| m.get("polarity"))
            .and_then(Value::as_str)
            .unwrap_or("unspecified")
            .into();
        let claim_ref = claim.local_ref.clone();
        let claim_evidence = claim.evidence.clone();
        let subject = endpoint(
            meta.and_then(|m| m.get("subject_ref"))
                .and_then(Value::as_str),
            output,
            input,
            &claim_evidence,
        )?;
        let object = endpoint(
            meta.and_then(|m| m.get("object_ref"))
                .and_then(Value::as_str),
            output,
            input,
            &claim_evidence,
        )?;
        output.claims[claim_index].subject_ref = subject.clone();
        output.claims[claim_index].object_ref = object.clone();
        if let Some(relation) = relation {
            let (Some(from_ref), Some(to_ref)) = (subject, object) else {
                return Err(error("memory_extract_invalid_correction"));
            };
            output.relations.push(ExtractRelation {
                claim_ref: claim_ref.clone(),
                from_ref,
                to_ref,
                relation: relation.into(),
                evidence: claim_evidence,
            });
        }
        output.corrections.push(ExtractCorrection {
            previous_claim_ref: candidate.ref_id.clone(),
            replacement_claim_ref: claim_ref,
            relation: "supersedes".into(),
            effective_at: None,
            evidence,
        });
    }
    Ok(warnings)
}

fn endpoint(
    id: Option<&str>,
    output: &mut ExtractOutput,
    input: &ExtractInput,
    evidence: &[QuoteRef],
) -> CognitionResult<Option<String>> {
    let Some(id) = id else { return Ok(None) };
    if let Some(node) = output
        .nodes
        .iter()
        .find(|n| matches!(&n.resolution,NodeResolution::Reuse{node_ref,..} if node_ref==id))
    {
        return Ok(Some(node.local_ref.clone()));
    }
    let candidate = input
        .candidates
        .iter()
        .find(|n| n.ref_id == id)
        .ok_or_else(|| error("memory_extract_correction_unresolved"))?;
    let past = historical_quote(candidate)
        .ok_or_else(|| error("memory_extract_correction_unresolved"))?
        .0;
    if candidate.node_type != "entity" && candidate.node_type != "project" {
        return Err(error("memory_extract_correction_unresolved"));
    }
    let first = evidence
        .first()
        .cloned()
        .ok_or_else(|| error("memory_extract_invalid_correction"))?;
    let local_ref = format!("n{}", output.nodes.len());
    output.nodes.push(ExtractNode {
        local_ref: local_ref.clone(),
        node_type: candidate.node_type.clone(),
        label: candidate.label.clone(),
        aliases: Vec::new(),
        evidence: evidence.to_vec(),
        resolution: NodeResolution::Reuse {
            node_ref: candidate.ref_id.clone(),
            reason: "bound_source".into(),
            evidence: vec![first, past],
        },
    });
    Ok(Some(local_ref))
}

pub(in crate::cognition) fn apply_repair(
    mut value: Value,
    batch: &BindingBatch,
    output: &mut ExtractOutput,
    input: &ExtractInput,
) -> CognitionResult<Vec<Value>> {
    let decisions = value
        .get_mut("decisions")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| error("memory_extract_invalid_binding"))?;
    for decision in decisions {
        let o = decision
            .as_object_mut()
            .ok_or_else(|| error("memory_extract_invalid_binding"))?;
        let current = o
            .remove("current_support")
            .and_then(|v| v.as_array().cloned())
            .ok_or_else(|| error("memory_extract_invalid_binding"))?;
        let historical = o
            .remove("selected_historical_support")
            .and_then(|v| v.as_array().cloned())
            .ok_or_else(|| error("memory_extract_invalid_binding"))?;
        if current.len() > 3 || historical.len() > 1 {
            return Err(error("memory_extract_invalid_binding"));
        }
        o.insert(
            "support".into(),
            Value::Array(current.into_iter().chain(historical).collect()),
        );
    }
    apply(value, batch, output, input)
}
