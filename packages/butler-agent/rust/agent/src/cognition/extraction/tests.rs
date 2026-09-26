use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{ExtractInput, meaning_prompt, source_passages};

#[test]
fn source_meaning_prompt_and_wire_hash_match_bun() {
    let fixture: Value =
        serde_json::from_str(include_str!("tests/fixtures/bun-meaning.json")).unwrap();
    let input: ExtractInput = serde_json::from_value(fixture["input"].clone()).unwrap();
    let passages = source_passages(&input).unwrap();
    assert_eq!(
        serde_json::to_value(&passages).unwrap(),
        fixture["passages"]
    );
    let prompt = crate::json::stringify(&meaning_prompt(&input, &passages).unwrap()).unwrap();
    assert_eq!(prompt, fixture["prompt"]);
    assert_eq!(
        format!("{:x}", Sha256::digest(prompt.as_bytes())),
        fixture["sha256"]
    );
}
