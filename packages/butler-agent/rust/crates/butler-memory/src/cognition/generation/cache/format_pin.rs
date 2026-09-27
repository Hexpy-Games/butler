//! Byte-level pin of the hot-cache file format: rendered bodies, audit text,
//! exclusions, and the entries read back. The golden was generated from the
//! pre-typing renderer; run with `BUTLER_BLESS_FORMAT=1` only for an intended
//! format change.

use std::{collections::HashSet, path::Path};

use serde_json::{Value, json};

use super::format::{SourceBackedHotCacheEntry, physical_entries, render};

const NOW: i64 = 1_790_000_000_000;

fn entry(id: &str, salience: &str, time: &str, valid_until: &Value, summary: &str) -> Value {
    json!({"entry_id":id,"episode_id":format!("episode-{id}"),"window_ref":format!("window-{id}"),
        "node_refs":["node-b","node-a"],"source_revision":"revision","source_time":time,
        "valid_until":valid_until,"kind":"preference+fact","summary":summary,"basis":["user_statement"],
        "salience":salience,"scope":"project","project_id":" project-1 ","session_id":"session-1",
        "graph_revision":7,"source_kind":"conversation","source_refs":["source-1"],
        "authority":"model_interpretation","source_class":"user"})
}

type Render = dyn Fn(&str, &Value, &[&str]) -> Value;

/// Rendering scenarios as (existing body, candidate, valid ids); earlier
/// renders build the existing bodies.
fn scenarios(render_with: &Render) -> Vec<(String, Value, Vec<&'static str>)> {
    let a = entry(
        "a",
        "high",
        "2026-01-02T00:00:00.000Z",
        &Value::Null,
        "  First summary  ",
    );
    let b = entry(
        "b",
        "normal",
        "2026-01-03T00:00:00.000Z",
        &Value::Null,
        "Second",
    );
    let expired = entry(
        "expired",
        "high",
        "2026-01-01T00:00:00.000Z",
        &json!("2020-01-01T00:00:00.000Z"),
        "Old",
    );
    let large = |id: &'static str| {
        entry(
            id,
            "unspecified",
            "2026-01-04T00:00:00.000Z",
            &Value::Null,
            &"x".repeat(7_000),
        )
    };
    let block = |value: &Value| {
        let rendered = render_with("", value, &["a", "b", "expired", "l1", "l2", "l3", "l4"]);
        rendered["body"].as_str().unwrap().to_owned()
    };
    let with_blocks = format!(
        "legacy line\n\n{}\n<!-- butler-semantic:broken:start -->\nno metadata\n<!-- butler-semantic:broken:end -->\n{}",
        block(&b),
        block(&expired)
    );
    let mut budget = String::new();
    for id in ["l1", "l2", "l3"] {
        budget.push_str(&block(&large(id)));
        budget.push('\n');
    }
    vec![
        (String::new(), a.clone(), vec!["a"]),
        (with_blocks.clone(), a.clone(), vec!["a", "b", "expired"]),
        (with_blocks, a.clone(), vec!["a"]),
        (block(&a), a.clone(), vec!["a"]),
        (budget, large("l4"), vec!["l1", "l2", "l3", "l4"]),
    ]
}

fn render_new(existing: &str, candidate: &Value, valid: &[&str]) -> Value {
    let candidate: SourceBackedHotCacheEntry = serde_json::from_value(candidate.clone()).unwrap();
    let valid = valid
        .iter()
        .map(|id| (*id).to_owned())
        .collect::<HashSet<_>>();
    let rendered = render(existing, Some(&candidate), &valid, NOW).unwrap();
    json!({"body":rendered.body,"audit":rendered.audit,"admitted":rendered.admitted,
        "replayed":rendered.replayed,"compacted":rendered.compacted,
        "excluded":rendered.excluded.iter().map(|item| json!([item.id, item.reason.as_str()])).collect::<Vec<_>>(),
        "physical":physical_entries(&rendered.body).iter().map(|view| json!([view.entry_id, view.scope, view.source_refs])).collect::<Vec<_>>()})
}

#[test]
fn hot_cache_render_keeps_its_pre_typing_bytes() {
    let actual = scenarios(&render_new)
        .iter()
        .map(|(existing, candidate, valid)| render_new(existing, candidate, valid))
        .collect::<Vec<_>>();
    let actual = serde_json::to_string_pretty(&actual).unwrap();
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/cognition/generation/fixtures/format/hot-cache-render.json");
    if std::env::var_os("BUTLER_BLESS_FORMAT").is_some() {
        std::fs::write(&path, &actual).unwrap();
        return;
    }
    assert_eq!(actual, std::fs::read_to_string(path).unwrap());
}
