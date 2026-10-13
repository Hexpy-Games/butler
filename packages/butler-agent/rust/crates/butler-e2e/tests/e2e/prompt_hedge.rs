//! Model prompts investigate reachable facts and retain evidence boundaries.
use std::collections::BTreeMap;

use butler_e2e::e2e::{HarnessError, binary::workspace_root};
use serde_json::Value;

#[tokio::test]
async fn model_facing_prompts_carry_no_handback_rules() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let root = workspace_root();
    let prefixes: BTreeMap<String, String> = serde_json::from_str(&std::fs::read_to_string(
        root.join("crates/butler-turn/src/btcc/guided_turn/phase/instruction-prefixes.json"),
    )?)?;
    for (key, text) in &prefixes {
        assert_no_handback(key, text);
        if key.starts_with("legacy|")
            || key.starts_with("delegated|steward|")
            || matches!(
                key.as_str(),
                "phase_minimal|butler|execution" | "phase_minimal|butler|read_only"
            )
        {
            assert!(
                text.contains("find out what tools can reach rather than guess or disclaim"),
                "{key} lacks the proactivity principle"
            );
        }
    }
    let catalog: Value = serde_json::from_str(&std::fs::read_to_string(
        root.join("crates/butler-runtime/src/capabilities/catalog/catalog.json"),
    )?)?;
    descriptions(&catalog);
    for entry in std::fs::read_dir(root.join("../resources/prompts"))? {
        let path = entry?.path();
        if path.extension().is_some_and(|ext| ext == "md") {
            assert_no_handback(
                &path.display().to_string(),
                &std::fs::read_to_string(&path)?,
            );
        }
    }
    assert_no_handback(
        "eol.template.md",
        &std::fs::read_to_string(root.join("../resources/templates/eol.template.md"))?,
    );
    Ok(())
}

fn descriptions(value: &Value) {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                if key == "description"
                    && let Some(text) = value.as_str()
                {
                    assert_no_handback("catalog description", text);
                }
                descriptions(value);
            }
        }
        Value::Array(items) => items.iter().for_each(descriptions),
        _ => {}
    }
}

fn assert_no_handback(source: &str, text: &str) {
    let text = text.to_lowercase();
    for forbidden in [
        "as unconfirmed",
        "verify it yourself",
        "smallest evidence set",
        "material limitation",
        "non-critical limits",
        "report the uncertainty",
        "untrusted data",
        "untrusted web data",
        "content is untrusted",
        "request verbatim",
        "never act or claim without evidence",
        "checks performed",
        "if you checked something",
    ] {
        assert!(!text.contains(forbidden), "{source} contains {forbidden}");
    }
}
