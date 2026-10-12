//! One fixture table for the standalone T2 contract, before the T3 tool exists.
use std::{path::Path, process::Command};

use serde_json::Value;

#[test]
fn answer_blocks_fixture_table() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let fixture: Value = serde_json::from_str(include_str!("answer_blocks/fixtures.json"))?;
    let cases = fixture["cases"].as_array().ok_or("fixture array missing")?;
    let mut requests = Vec::new();
    for case in cases {
        let mut spec =
            fixture["specs"][case["spec"].as_str().ok_or("fixture string missing")?].clone();
        for change in case["changes"].as_array().ok_or("fixture array missing")? {
            let path = change["path"].as_str().ok_or("fixture string missing")?;
            let (parent, key) = path.rsplit_once('/').ok_or("fixture pointer missing")?;
            let object = spec.pointer_mut(parent).ok_or("fixture path missing")?;
            if change["remove"] == true {
                object
                    .as_object_mut()
                    .ok_or("fixture object missing")?
                    .remove(key);
            } else if let Some(fields) = object.as_object_mut() {
                fields.insert(key.into(), change["value"].clone());
            } else {
                object[key.parse::<usize>()?] = change["value"].clone();
            }
        }
        requests.push(serde_json::json!({
            "spec": spec, "images": fixture["images"], "sources": fixture["sources"],
            "now": "2026-10-12T12:00:00Z",
        }));
    }
    let input = Path::new(&std::env::var("BUTLER_DATA")?).join("answer-blocks-input.json");
    std::fs::write(&input, serde_json::to_vec(&requests)?)?;
    let output = Command::new(env!("CARGO_BIN_EXE_e2e-answer-blocks"))
        .stdin(std::fs::File::open(&input)?)
        .output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let results: Vec<Value> = serde_json::from_slice(&output.stdout)?;
    assert_eq!(results.len(), cases.len());
    for (case, result) in cases.iter().zip(results) {
        assert_eq!(result["ok"], case["accept"], "{}: {result}", case["name"]);
        if case["accept"] == true {
            continue;
        }
        let errors = result["problems"]
            .as_array()
            .ok_or("fixture array missing")?;
        assert!(errors.len() <= 10);
        for expected in case["problems"].as_array().ok_or("fixture array missing")? {
            assert!(
                errors.iter().any(|e| e["path"] == expected["path"]
                    && e["fix"].as_str().is_some_and(|fix| expected["fix"]
                        .as_str()
                        .is_some_and(|expected| fix.contains(expected)))),
                "{}: {errors:?}",
                case["name"]
            );
        }
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../..");
    let output = Command::new("bun")
        .arg(root.join("tests/contracts/answer-blocks.ts"))
        .current_dir(root)
        .output()?;
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}
