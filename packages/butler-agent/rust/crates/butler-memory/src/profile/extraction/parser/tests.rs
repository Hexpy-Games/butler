use super::*;

fn target(id: usize) -> CorrectionTarget {
    CorrectionTarget {
        stable_id: format!("stable-{id}"),
        category: "communication".into(),
        facet: None,
        applies_when: Vec::new(),
        revision: format!("revision-{id}"),
    }
}

#[test]
fn strict_parser_accepts_case_insensitive_json_fence() {
    let allowed = HashSet::from(["evidence".into()]);
    let parsed = strict(
        "```JsOn\n{\"candidates\":[{\"category\":\"communication\",\"summary\":\"Concise\",\"evidence_refs\":[\"evidence\"]}]}\n```",
        &allowed,
        ProfilingMode::Basic,
        &HashMap::new(),
    )
    .unwrap();
    assert_eq!(parsed.len(), 1);
}

#[test]
fn strict_parser_validates_correction_refs_beyond_retained_six() {
    let allowed = HashSet::from(["evidence".into()]);
    let targets = (0..6)
        .map(|index| (format!("target-{index}"), target(index)))
        .collect::<HashMap<_, _>>();
    let corrections = (0..7)
        .map(|index| format!("target-{index}"))
        .collect::<Vec<_>>();
    let raw = serde_json::json!({"candidates":[{
        "category":"communication","summary":"Concise","source_type":"explicit",
        "evidence_refs":["evidence"],"contradiction_refs":corrections
    }]})
    .to_string();
    assert!(strict(&raw, &allowed, ProfilingMode::Basic, &targets).is_err());
}
