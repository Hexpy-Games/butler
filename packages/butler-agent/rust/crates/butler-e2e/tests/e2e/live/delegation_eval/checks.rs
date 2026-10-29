//! Conservative, report-only artifact checks; unknown content stays unjudged.
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

pub(super) fn inspect(root: &Path, case: &Value, graph: &Value) -> Result<Value, HarnessError> {
    let mut files = BTreeMap::new();
    collect(root, root, &mut files)?;
    let contents = |path: &str| {
        files
            .get(path)
            .map(|v: &Vec<u8>| String::from_utf8_lossy(v).into_owned())
            .unwrap_or_default()
    };
    let validation = graph["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["tool_name"] == "run_command" && t["status"] == "completed")
        .map(|t| json!({"arguments":t["arguments_json"],"result":t["result_json"]}))
        .collect::<Vec<_>>();
    let looks_met = match case["id"].as_str().unwrap() {
        "w03-three-proposals" => {
            let proposals: Vec<_> = files
                .iter()
                .filter(|(p, _)| p.starts_with("proposals/") && p.ends_with(".md"))
                .collect();
            Some(
                proposals.len() == 3
                    && proposals
                        .iter()
                        .map(|(_, v)| *v)
                        .collect::<BTreeSet<_>>()
                        .len()
                        == 3,
            )
        }
        "w08-summarize-files" => {
            let text = contents("decisions.md");
            Some(
                ["7/15", "50", "9,900", "지민", "현우", "서연"]
                    .iter()
                    .all(|s| text.contains(s)),
            )
        }
        // Existence is necessary, but alone cannot prove charts, English, A4, sources or tests.
        _ => None,
    };
    let facts = json!({"files":files.iter().map(|(p,b)|json!({"path":p,"bytes":b.len()})).collect::<Vec<_>>(),
        "python_contains_old_name":files.iter().filter(|(p,_)|p.ends_with(".py")).any(|(_,b)|String::from_utf8_lossy(b).contains("fetch_user")),
        "greeting_corrected":contents("greet.py").contains("Hello, "),
        "translation_files":(["notes/a.en.md","notes/b.en.md","notes/c.en.md"].map(|p|json!({"path":p,"exists":files.contains_key(p)}))),
        "chart_file_exists":files.contains_key("dram.html"),"validation_commands":validation});
    Ok(
        json!({"looks_met":looks_met,"checks":case["checks"],"facts":facts,
        "note":"Report only. null means human review needed; retained artifacts and full tool results are authoritative evidence."}),
    )
}
fn collect(
    root: &Path,
    dir: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
) -> Result<(), HarnessError> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            collect(root, &entry.path(), files)?;
        } else if kind.is_file() {
            files.insert(
                entry
                    .path()
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                std::fs::read(entry.path())?,
            );
        }
    }
    Ok(())
}

/// End-to-end contracts shared by both offline variant runs.
pub(super) fn verify(case: &Value, first: bool, row: &Value, workspace: &Path) {
    let samples = row["samples"].as_array().unwrap();
    let graph = &row["db"];
    for prior in case["history"].as_array().into_iter().flatten() {
        assert!(
            samples[0]["request"]
                .to_string()
                .contains(prior["butler"].as_str().unwrap()),
            "seeded history is missing"
        );
    }
    assert!(
        samples[0]["instruction_tool_tokens_o200k_estimate"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert_eq!(row["outcome"], "completed", "{row}");
    if first {
        assert_eq!(samples.len(), 1);
        if let Some(output) = case["first_output"].as_array() {
            let expected: Vec<_> = output
                .iter()
                .filter(|v| v["type"] == "function_call")
                .map(|v| v["name"].as_str().unwrap().trim_start_matches("butler."))
                .collect();
            let actual: Vec<_> = samples[0]["calls"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["name"].as_str().unwrap())
                .collect();
            assert_eq!(actual, expected);
            assert_eq!(row["upstream_rounds"], 1);
            assert!(row["harness_error_reason"].is_null());
        } else if case["label"] == "delegate" {
            assert_eq!(samples[0]["calls"][0]["name"], "delegate_to_steward");
        } else {
            assert_eq!(samples[0]["calls"], json!([]));
        }
        assert_eq!(
            graph["executed_tools"],
            json!([]),
            "evaluated tools executed"
        );
    } else {
        let expected = if row["variant"] == "old" {
            json!([
                "start_work",
                "replace_work_plan",
                "record_work_review",
                "delegate_to_steward"
            ])
        } else {
            json!(["delegate_to_steward"])
        };
        assert_eq!(row["local_calls"], expected);
        let parent = graph["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["role"] == "butler")
            .map(|t| t["tool_name"].clone())
            .collect::<Vec<_>>();
        for (actual, expected) in parent.iter().zip(expected.as_array().unwrap()) {
            assert_eq!(actual, expected);
        }
        assert!(parent.len() >= expected.as_array().unwrap().len());
        assert_eq!(graph["plan_gate_refusals"], 1, "{graph}");
        assert_eq!(graph["plan_before_first_mutation"], false, "{graph}");
        assert_eq!(graph["plan_review_accepted"], true, "{graph}");
        assert_eq!(graph["workers_when_expected"], true, "{graph}");
        assert_eq!(graph["disposition_recorded"], true, "{graph}");
        assert!(!workspace.join("premature.txt").exists());
    }
}
