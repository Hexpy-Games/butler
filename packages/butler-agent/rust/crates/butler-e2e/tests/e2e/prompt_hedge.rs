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
                text.contains("else best judgment and why"),
                "{key} lacks judgment"
            );
            assert!(
                text.contains("find out what tools can reach rather than guess or disclaim"),
                "{key} lacks the proactivity principle"
            );
        }
        if key.starts_with("legacy|") {
            assert!(text.contains("Look up what the user said earlier"));
        }
        if key == "phase_minimal|butler|direct" {
            assert!(text.contains("including what the user said earlier"));
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
    let eol = std::fs::read_to_string(root.join("../resources/templates/eol.template.md"))?;
    assert_no_handback("eol.template.md", &eol);
    assert!(eol.contains("give your best judgment, why, and what would change it"));
    assert!(eol.contains("before relying on something the principal told you, look it up"));
    assert_no_limits_persona(&root.join("../resources/personas/templates"))?;
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
        "claim only what evidence or tool results support",
        "verification limits",
        "residual risk",
        "non-critical gaps",
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

fn assert_no_limits_persona(directory: &std::path::Path) -> Result<(), HarnessError> {
    for entry in std::fs::read_dir(directory)? {
        let path = entry?.path();
        if path.is_dir() {
            assert_no_limits_persona(&path)?;
        } else if path.extension().is_some_and(|ext| ext == "md") {
            let text = std::fs::read_to_string(&path)?.to_lowercase();
            for forbidden in [
                "limits clear",
                "state uncertainty openly",
                "do not hide uncertainty",
                "근거와 한계",
                "사실과 한계",
                "불확실성을 숨기지",
            ] {
                assert!(
                    !text.contains(forbidden),
                    "{} contains {forbidden}",
                    path.display()
                );
            }
        }
    }
    Ok(())
}
