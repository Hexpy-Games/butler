use super::*;
use serde::Deserialize;

fn is_public_text_safe(value: &str) -> bool {
    sanitize_public_text(value, "") == trim_js_whitespace(value)
}

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    value: Value,
    fallback: String,
    output: String,
    safe: Option<bool>,
}

#[test]
fn matches_bun_public_projection_with_boundaries_and_encoded_candidates() {
    let fixture: Fixture = serde_json::from_str(include_str!("bun-fixture.json")).unwrap();
    for (index, case) in fixture.cases.iter().enumerate() {
        assert_eq!(
            sanitize_public_value(&case.value, &case.fallback),
            case.output,
            "case {index}: {:?}",
            case.value
        );
        if let (Some(text), Some(safe)) = (case.value.as_str(), case.safe) {
            assert_eq!(
                is_public_text_safe(text),
                safe,
                "safety case {index}: {text:?}"
            );
        }
    }
}
