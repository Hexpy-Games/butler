//! One fixture table for the standalone T2 contract, before the T3 tool exists.
use butler_e2e::e2e::binary::fixture_binary;
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
    let output = Command::new(fixture_binary("e2e-answer-blocks")?)
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
    let root = butler_e2e::e2e::binary::manifest_dir().join("../../../../..");
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

#[test]
fn answer_blocks_stream_byte_splits_and_item_validation() -> Result<(), Box<dyn std::error::Error>>
{
    butler_e2e::gate!();
    let fixture: Value = serde_json::from_str(include_str!("answer_blocks/fixtures.json"))?;
    let mut requests: Vec<_> = fixture["specs"].as_object().ok_or("specs missing")?.values()
        .map(|spec| serde_json::json!({"spec":spec,"images":fixture["images"],"sources":fixture["sources"],"now":"2026-10-12T12:00:00Z","stream":true})).collect();
    let raw = r#"{"v":1,"blocks":[{"type":"cards","items":[{"title":"First \"quoted\" 한국어","img":" img_0123456789 "},{"title":"Second"}]}]}"#;
    let prefix = raw.find(",{\"title\":\"Second").ok_or("prefix missing")?;
    requests.push(serde_json::json!({"spec":serde_json::from_str::<Value>(raw)?,"raw":raw,"prefix":prefix,"images":["img_0123456789"],"sources":[],"now":"2026-10-12T12:00:00Z","stream":true}));
    let invalid = serde_json::json!({"v":1,"blocks":[{"type":"cards","items":[
        {"title":" Good ","key":"one"},
        {"title":"Unknown asset","img":"img_abcdefghij"},
        {"title":"Unsourced price","value":{"amount":10}},
        {"title":"Unread price","value":{"amount":10},"source":"https://unread.example/item","checked":"2026-10-12T12:00:00Z"},
        {"title":"Unknown key","extra":true},
        {"title":"Duplicate key","key":"one"}
    ]}]});
    requests.push(serde_json::json!({"spec":invalid,"images":[],"sources":[],"now":"2026-10-12T12:00:00Z","stream":true}));
    let unread_chart = serde_json::json!({"v":1,"blocks":[{"type":"chart","kind":"line","x":["A"],
        "series":[{"name":"S","values":[1]}],"source":"https://unread.example/chart","checked":"2026-10-12T11:55:00Z"}]});
    requests.push(serde_json::json!({"spec":unread_chart,"images":[],"sources":[],"now":"2026-10-12T12:00:00Z","stream":true}));
    requests.push(serde_json::json!({"spec":{},"images":[],"sources":[],"now":"2026-10-12T12:00:00Z","perf":true}));
    let mut results = run_stream_requests(&requests)?;
    let large = results.pop().ok_or("no large-stream result")?;
    eprintln!("24 KB parser: {large}");
    assert_eq!(large["items"], 48);
    let chart = results.pop().ok_or("no results")?;
    let chart_ops = chart["ops"].as_array().ok_or("ops missing")?;
    assert!(
        !chart_ops
            .iter()
            .any(|op| op["field"] == "source" || op["field"] == "series"),
        "an unread chart source must never be released: {chart_ops:?}"
    );
    let prefix_ops = results[results.len() - 2]["prefixOps"]
        .as_array()
        .ok_or("prefix missing")?;
    assert_eq!(prefix_ops.iter().filter(|op| op["op"] == "item").count(), 1);
    assert!(
        !prefix_ops
            .iter()
            .any(|op| op["op"] == "list_end" || op["op"] == "block_end")
    );
    let last = results.last().ok_or("no results")?;
    let items: Vec<_> = last["ops"]
        .as_array()
        .ok_or("ops missing")?
        .iter()
        .filter(|op| op["op"] == "item")
        .collect();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["value"]["title"], "Good");
    eprintln!(
        "stream fixtures={} byte splits={}",
        results.len(),
        results
            .iter()
            .filter_map(|r| r["splits"].as_u64())
            .sum::<u64>()
    );
    Ok(())
}

fn run_stream_requests(requests: &[Value]) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    use std::io::Write;
    let input = Path::new(&std::env::var("BUTLER_DATA")?)
        .join(format!("stream-{}.json", uuid::Uuid::new_v4()));
    std::fs::File::create(&input)?.write_all(&serde_json::to_vec(requests)?)?;
    let output = Command::new(fixture_binary("e2e-answer-blocks")?)
        .stdin(std::fs::File::open(&input)?)
        .output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

#[test]
fn answer_blocks_container_children_close_before_tab() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let raw = r#"{"v":2,"blocks":[{"type":"tabs","title":"Details","tabs":[{"label":"Status","blocks":[{"type":"text","text":"First"},{"type":"text","text":"Second"}]},{"label":"Other","blocks":[{"type":"quote","text":"Complete"}]}]}]}"#;
    let prefix = raw
        .find(",{\"type\":\"text\",\"text\":\"Second")
        .ok_or("prefix missing")?;
    let results = run_stream_requests(&[
        serde_json::json!({"spec":serde_json::from_str::<Value>(raw)?,"raw":raw,"prefix":prefix,"images":[],"sources":[],"now":"2026-10-12T12:00:00Z","stream":true}),
    ])?;
    let ops = results[0]["prefixOps"]
        .as_array()
        .ok_or("prefix ops missing")?;
    assert!(
        ops.iter()
            .any(|op| op["op"] == "tab" && op["label"] == "Status")
    );
    let children: Vec<_> = ops.iter().filter(|op| op["op"] == "child").collect();
    assert_eq!(children.len(), 1);
    assert_eq!(
        children[0]["value"],
        serde_json::json!({"type":"text","text":"First"})
    );
    assert!(
        !ops.iter()
            .any(|op| op["op"] == "block_end" || (op["op"] == "item" && op["list"] == "tabs"))
    );
    Ok(())
}
