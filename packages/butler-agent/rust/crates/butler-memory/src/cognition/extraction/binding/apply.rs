//! Applying binding decisions. Each decision is shape-checked and applied in
//! order, so the first violation's code (sent back to the model on repair)
//! does not depend on later decisions.

use super::*;
use crate::cognition::CognitionCode;
use crate::cognition::extraction::{ExtractClaim, ExtractCorrection, ExtractNode, ExtractRelation};

/// A decision that was valid but could not be applied; recorded in the
/// projection evidence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(in crate::cognition) struct BindingWarning {
    code: BindingWarningCode,
    target_ref: String,
}

/// Why a change decision was not applied.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(in crate::cognition) enum BindingWarningCode {
    /// The model chose no candidate or no span for a change.
    CorrectionUnresolved,
    /// The past claim's subject or object is not available in this window.
    CorrectionContextUnavailable,
}

impl BindingWarning {
    fn new(code: BindingWarningCode, target_ref: &str) -> Self {
        Self {
            code,
            target_ref: target_ref.to_owned(),
        }
    }
}

/// One decision after its shape was checked.
struct Decision<'a> {
    target: &'a Target,
    candidate: Option<&'a str>,
    span: Option<&'a str>,
    support: Vec<&'a str>,
}

/// A selected candidate with the quotes its decision cites.
struct Selected<'a> {
    reference: &'a str,
    candidate: &'a ExtractCandidate,
    evidence: Vec<QuoteRef>,
}

/// Applies the model's `{"decisions": [...]}` (one per batch target) to
/// `output`. Parse boundary: `value` is the model's JSON.
pub(in crate::cognition) fn apply(
    value: &Value,
    batch: &BindingBatch,
    output: &mut ExtractOutput,
    input: &ExtractInput,
) -> CognitionResult<Vec<BindingWarning>> {
    let invalid = || error(CognitionCode::MemoryExtractInvalidBinding);
    let decisions = value
        .get("decisions")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if decisions.len() != batch.targets.len() || decisions.len() > 4 {
        return Err(invalid());
    }
    let mut seen = HashSet::new();
    let mut warnings = Vec::new();
    for decision in decisions {
        let decision = parse_decision(decision, batch, &mut seen)?;
        if let Some(warning) = apply_decision(&decision, batch, output, input)? {
            warnings.push(warning);
        }
    }
    Ok(warnings)
}

/// A repair response names support as `current_support` and
/// `selected_historical_support`; merges them into `support` and applies.
/// Parse boundary: `value` is the model's JSON.
pub(in crate::cognition) fn apply_repair(
    mut value: Value,
    batch: &BindingBatch,
    output: &mut ExtractOutput,
    input: &ExtractInput,
) -> CognitionResult<Vec<BindingWarning>> {
    let invalid = || error(CognitionCode::MemoryExtractInvalidBinding);
    let decisions = value
        .get_mut("decisions")
        .and_then(Value::as_array_mut)
        .ok_or_else(invalid)?;
    for decision in decisions {
        let o = decision.as_object_mut().ok_or_else(invalid)?;
        let current = o
            .remove("current_support")
            .and_then(|v| v.as_array().cloned())
            .ok_or_else(invalid)?;
        let historical = o
            .remove("selected_historical_support")
            .and_then(|v| v.as_array().cloned())
            .ok_or_else(invalid)?;
        if current.len() > 3 || historical.len() > 1 {
            return Err(invalid());
        }
        o.insert(
            "support".into(),
            Value::Array(current.into_iter().chain(historical).collect()),
        );
    }
    apply(&value, batch, output, input)
}

/// `{target, candidate, span, support}` naming a batch target once, with
/// string refs (at most 4 support refs).
fn parse_decision<'a>(
    decision: &'a Value,
    batch: &'a BindingBatch,
    seen: &mut HashSet<&'a str>,
) -> CognitionResult<Decision<'a>> {
    let invalid = || error(CognitionCode::MemoryExtractInvalidBinding);
    let o = decision.as_object().ok_or_else(invalid)?;
    if o.len() != 4
        || !["target", "candidate", "span", "support"]
            .iter()
            .all(|k| o.contains_key(*k))
    {
        return Err(invalid());
    }
    let field = |key: &str| o.get(key).unwrap_or(&Value::Null);
    let reference = field("target").as_str().ok_or_else(invalid)?;
    if !seen.insert(reference) {
        return Err(invalid());
    }
    let target = batch
        .targets
        .iter()
        .find(|t| t.local_ref == reference)
        .ok_or_else(|| error(CognitionCode::MemoryExtractInvalidRef))?;
    let support = field("support")
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .map(Value::as_str)
        .collect::<Option<Vec<_>>>()
        .filter(|refs| refs.len() <= 4)
        .ok_or_else(invalid)?;
    let span = field("span").as_str();
    if !field("span").is_null() && span.is_none() {
        return Err(invalid());
    }
    let candidate = field("candidate").as_str();
    if candidate.is_none() && !field("candidate").is_null() {
        return Err(invalid());
    }
    Ok(Decision {
        target,
        candidate,
        span,
        support,
    })
}

/// Applies one decision: none (a warning for a change), an entity reuse, or
/// a change correction.
fn apply_decision(
    decision: &Decision<'_>,
    batch: &BindingBatch,
    output: &mut ExtractOutput,
    input: &ExtractInput,
) -> CognitionResult<Option<BindingWarning>> {
    let target = decision.target;
    let Some(selected) = decision.candidate else {
        if decision.span.is_some() || !decision.support.is_empty() {
            return Err(error(CognitionCode::MemoryExtractInvalidBinding));
        }
        return Ok(target.change.then(|| {
            BindingWarning::new(BindingWarningCode::CorrectionUnresolved, &target.local_ref)
        }));
    };
    let selected = select(decision, selected, batch)?;
    if target.change {
        correct(decision, &selected, output, input)
    } else {
        reuse(decision, selected, output).map(|()| None)
    }
}

/// The chosen candidate, when the support cites both current evidence and
/// the candidate's own historical quote, and nothing else.
fn select<'a>(
    decision: &Decision<'a>,
    reference: &'a str,
    batch: &'a BindingBatch,
) -> CognitionResult<Selected<'a>> {
    let reuse_error = || error(CognitionCode::MemoryExtractInvalidIdentityReuse);
    let target = decision.target;
    let candidate = target.candidates.get(reference).ok_or_else(reuse_error)?;
    let historical = target
        .historical_refs
        .get(reference)
        .ok_or_else(reuse_error)?;
    let refs = &decision.support;
    let current = |r: &&str| target.current_refs.contains(*r);
    let past = |r: &&str| historical.contains(*r);
    if !refs.iter().any(current)
        || !refs.iter().any(past)
        || refs.iter().any(|r| !current(r) && !past(r))
    {
        return Err(reuse_error());
    }
    let evidence = refs
        .iter()
        .map(|r| batch.quotes.get(*r).cloned().ok_or_else(reuse_error))
        .collect::<CognitionResult<Vec<_>>>()?;
    Ok(Selected {
        reference,
        candidate,
        evidence,
    })
}

/// An entity target reuses the chosen identity node.
fn reuse(
    decision: &Decision<'_>,
    selected: Selected<'_>,
    output: &mut ExtractOutput,
) -> CognitionResult<()> {
    let candidate = selected.candidate;
    if decision.span.is_some() || !candidate.is_identity_node() {
        return Err(error(CognitionCode::MemoryExtractInvalidBinding));
    }
    let node = output
        .nodes
        .iter_mut()
        .find(|n| n.local_ref == decision.target.local_ref)
        .ok_or_else(|| error(CognitionCode::MemoryExtractInvalidRef))?;
    node.node_type = candidate.node_type.clone();
    node.resolution = NodeResolution::Reuse {
        node_ref: candidate.ref_id.clone(),
        reason: "named_context".into(),
        evidence: selected.evidence,
    };
    Ok(())
}

/// A change target rewrites the chosen span of the past claim into its own
/// claim, takes over the past claim's endpoints and relation, and records
/// that it supersedes the past claim.
fn correct(
    decision: &Decision<'_>,
    selected: &Selected<'_>,
    output: &mut ExtractOutput,
    input: &ExtractInput,
) -> CognitionResult<Option<BindingWarning>> {
    let target = decision.target;
    let candidate = selected.candidate;
    if candidate.is_identity_node() {
        return Err(error(CognitionCode::MemoryExtractInvalidBinding));
    }
    let chosen = decision.span.and_then(|r| target.spans.get(r));
    if decision.span.is_some() && chosen.is_none_or(|s| s.candidate != selected.reference) {
        return Err(error(CognitionCode::MemoryExtractInvalidBinding));
    }
    let warning = |code| Ok(Some(BindingWarning::new(code, &target.local_ref)));
    let Some(chosen) = chosen else {
        return warning(BindingWarningCode::CorrectionUnresolved);
    };
    let claim_index = output
        .claims
        .iter()
        .position(|c| c.local_ref == target.local_ref)
        .ok_or_else(|| error(CognitionCode::MemoryExtractInvalidRef))?;
    let past = candidate.claim.as_ref();
    let endpoint_refs = past
        .map(|claim| [claim.subject_ref.as_deref(), claim.object_ref.as_deref()])
        .unwrap_or_default()
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let relation = past.and_then(|claim| claim.relation.as_deref());
    if !endpoint_refs
        .iter()
        .all(|id| endpoint_available(id, output, input))
        || relation.is_some() && endpoint_refs.len() != 2
    {
        return warning(BindingWarningCode::CorrectionContextUnavailable);
    }
    let claim = output
        .claims
        .get_mut(claim_index)
        .ok_or_else(|| error(CognitionCode::MemoryExtractInvalidRef))?;
    rewrite_claim(claim, selected, chosen)?;
    let claim_ref = claim.local_ref.clone();
    let claim_evidence = claim.evidence.clone();
    let subject = endpoint(
        past.and_then(|claim| claim.subject_ref.as_deref()),
        output,
        input,
        &claim_evidence,
    )?;
    let object = endpoint(
        past.and_then(|claim| claim.object_ref.as_deref()),
        output,
        input,
        &claim_evidence,
    )?;
    if let Some(claim) = output.claims.get_mut(claim_index) {
        claim.subject_ref.clone_from(&subject);
        claim.object_ref.clone_from(&object);
    }
    if let Some(relation) = relation {
        let (Some(from_ref), Some(to_ref)) = (subject, object) else {
            return Err(error(CognitionCode::MemoryExtractInvalidCorrection));
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
        evidence: selected.evidence.clone(),
    });
    Ok(None)
}

/// A past claim's endpoint is available when this output already reuses it
/// or it is a quotable identity candidate of the input.
fn endpoint_available(id: &str, output: &ExtractOutput, input: &ExtractInput) -> bool {
    output
        .nodes
        .iter()
        .any(|n| matches!(&n.resolution, NodeResolution::Reuse { node_ref, .. } if node_ref == id))
        || input.candidates.iter().any(|n| {
            n.ref_id == id && n.is_identity_node() && historical_quote(n).is_some()
        })
}

/// The claim cites the decision's quotes and states the past statement with
/// the chosen span replaced; type, condition and polarity follow the past
/// claim.
fn rewrite_claim(
    claim: &mut ExtractClaim,
    selected: &Selected<'_>,
    chosen: &Span,
) -> CognitionResult<()> {
    for quote in &selected.evidence {
        if !claim.evidence.contains(quote) {
            claim.evidence.push(quote.clone());
        }
    }
    let past = selected.candidate.claim.as_ref();
    let previous = past.map_or(selected.candidate.label.as_str(), |claim| {
        claim.statement.as_str()
    });
    let (Some(head), Some(tail)) = (previous.get(..chosen.start), previous.get(chosen.end..))
    else {
        return Err(error(CognitionCode::MemoryExtractInvalidBinding));
    };
    claim.statement = format!("{head}{}{tail}", chosen.value);
    claim.claim_type = selected.candidate.node_type.clone();
    claim.condition = past.and_then(|claim| claim.condition.clone());
    claim.polarity = past
        .and_then(|claim| claim.polarity.as_deref())
        .unwrap_or("unspecified")
        .into();
    Ok(())
}

/// The local ref of a past claim's endpoint: the node already reusing it,
/// or a new reuse node for that identity candidate.
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
    let unresolved = || error(CognitionCode::MemoryExtractCorrectionUnresolved);
    let candidate = input
        .candidates
        .iter()
        .find(|n| n.ref_id == id)
        .ok_or_else(unresolved)?;
    let past = historical_quote(candidate).ok_or_else(unresolved)?.0;
    if !candidate.is_identity_node() {
        return Err(unresolved());
    }
    let first = evidence
        .first()
        .cloned()
        .ok_or_else(|| error(CognitionCode::MemoryExtractInvalidCorrection))?;
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
