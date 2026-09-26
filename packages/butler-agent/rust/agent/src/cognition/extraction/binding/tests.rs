
use super::*;
use crate::cognition::extraction::CandidateEvidence;

fn fixture() -> (BindingBatch, ExtractOutput, ExtractInput) {
    let candidate = ExtractCandidate {
        ref_id: "past-claim".into(),
        node_type: "memory_atom".into(),
        label: "deadline 2026".into(),
        aliases: vec![],
        scope: "user".into(),
        project_id: None,
        claim: Some(
            json!({"statement":"deadline 2026","polarity":"positive","condition":null,
                "subject_ref":null,"object_ref":null,"relation":null}),
        ),
        evidence: vec![CandidateEvidence {
            ref_id: "past-source".into(),
            text: "deadline 2026.".into(),
            observed_at: "2026-01-01T00:00:00Z".into(),
            basis: "direct".into(),
        }],
    };
    let current = QuoteRef {
        unit_ref: "current-source".into(),
        quote: "deadline changed to 2027".into(),
        occurrence: 0,
    };
    let past = QuoteRef {
        unit_ref: "past-source".into(),
        quote: "deadline 2026.".into(),
        occurrence: 0,
    };
    let batch = BindingBatch {
        prompt: json!({"targets":[],"evidence":[]}),
        targets: vec![Target {
            local_ref: "f0".into(),
            candidates: HashMap::from([("f0c0".into(), candidate.clone())]),
            current_refs: HashSet::from(["f0u0".into()]),
            historical_refs: HashMap::from([("f0c0".into(), HashSet::from(["f0c0h".into()]))]),
            spans: HashMap::from([(
                "f0c0p0".into(),
                Span {
                    candidate: "f0c0".into(),
                    start: 9,
                    end: 13,
                    value: "2027".into(),
                },
            )]),
            change: true,
        }],
        quotes: HashMap::from([("f0u0".into(), current.clone()), ("f0c0h".into(), past)]),
    };
    let output=serde_json::from_value(json!({"schema":"memory.extract.v1","window_ref":"window","disposition":"processed",
            "covered_unit_refs":["current-source"],"nodes":[],"claims":[{"local_ref":"f0","type":"memory_atom",
            "resolution":{"kind":"create","provisional":false,"identity_scope":"user"},"statement":"deadline changed to 2027",
            "subject_ref":null,"object_ref":null,"speech_act":"assertion","basis":"direct","polarity":"unspecified","condition":null,
            "valid_from":null,"valid_to":null,"salience":"normal","evidence":[current]}],"relations":[],"corrections":[],"summary":null})).unwrap();
    let input = serde_json::from_value(
        json!({"schema":"memory.extract.v1","episode_ref":"e","revision":"r","window_ref":"window",
            "bound_project_id":null,"source_units":[],"context_units":[],"candidates":[candidate]}),
    )
    .unwrap();
    (batch, output, input)
}

#[test]
fn correction_rewrites_only_selected_span_and_records_supersedes() {
    let (batch, mut output, input) = fixture();
    let warnings = apply(
        json!({"decisions":[{"target":"f0","candidate":"f0c0","span":"f0c0p0",
            "support":["f0u0","f0c0h"]}]}),
        &batch,
        &mut output,
        &input,
    )
    .unwrap();
    assert!(warnings.is_empty());
    assert_eq!(output.claims[0].statement, "deadline 2027");
    assert_eq!(output.corrections[0].previous_claim_ref, "past-claim");
    assert_eq!(output.claims[0].evidence.len(), 2);
}

#[test]
fn correction_rejects_cross_candidate_evidence_and_unresolved_is_explicit() {
    let (batch, mut output, input) = fixture();
    let bad = json!({"decisions":[{"target":"f0","candidate":"f0c0","span":"f0c0p0","support":["f0u0","another-history"]}]});
    assert_eq!(
        apply(bad, &batch, &mut output, &input).unwrap_err().code,
        "memory_extract_invalid_identity_reuse"
    );
    let warning = apply(
        json!({"decisions":[{"target":"f0","candidate":null,"span":null,"support":[]}]}),
        &batch,
        &mut output,
        &input,
    )
    .unwrap();
    assert_eq!(
        warning,
        vec![json!({"code":"correction_unresolved","target_ref":"f0"})]
    );
    assert!(output.corrections.is_empty());
}
