//! Dev-only process verification of incremental parsing and complete operation output.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "E2E fixture assertions"
)]
use butler_runtime::capabilities::answer_blocks::{
    self, AnswerBlocksContext, AnswerBlocksDraftOp, AnswerBlocksParser,
};
use serde_json::{Value, json};
use std::time::Instant;

fn parse(chunks: &[&[u8]], context: &AnswerBlocksContext<'_>) -> Vec<AnswerBlocksDraftOp> {
    let mut parser = AnswerBlocksParser::default();
    let mut ops = Vec::new();
    for chunk in chunks {
        for unit in parser.push(chunk) {
            ops.extend(parser.apply(unit, context));
        }
    }
    ops
}

pub(super) fn verify(
    spec: &Value,
    raw: Option<&str>,
    prefix: usize,
    context: &AnswerBlocksContext<'_>,
) -> Value {
    let bytes = raw.map_or_else(
        || serde_json::to_vec(spec).unwrap(),
        |s| s.as_bytes().to_vec(),
    );
    let prefix_ops = parse(&[&bytes[..prefix]], context);
    let expected = parse(&[&bytes], context);
    for split in 0..=bytes.len() {
        assert_eq!(
            parse(&[&bytes[..split], &bytes[split..]], context),
            expected,
            "split {split}"
        );
    }
    let chunks: Vec<_> = bytes.chunks(1).collect();
    assert_eq!(parse(&chunks, context), expected, "one byte fragments");
    let mut normalized = spec.clone();
    answer_blocks::normalize(&mut normalized);
    if answer_blocks::validate_answer_blocks(&normalized, context).is_ok() {
        assert_eq!(reconstruct(&expected), normalized["blocks"]);
        for bi in 0..normalized["blocks"].as_array().unwrap().len() {
            assert_eq!(
                expected
                    .iter()
                    .rev()
                    .find(|op| op.value["bi"] == bi)
                    .unwrap()
                    .value["op"],
                "block_end"
            );
        }
        for (bi, block) in normalized["blocks"].as_array().unwrap().iter().enumerate() {
            for list in ["items", "rows"] {
                if let Some(items) = block[list].as_array() {
                    let actual: Vec<_> = expected
                        .iter()
                        .filter(|op| {
                            op.value["op"] == "item"
                                && op.value["bi"] == bi
                                && op.value["list"] == list
                        })
                        .map(|op| op.value["value"].clone())
                        .collect();
                    assert_eq!(&actual, items, "complete normalized {list}");
                }
            }
        }
    }
    json!({"ops":expected,"splits":bytes.len()+1,"prefixOps":prefix_ops})
}

pub(super) fn perf(context: &AnswerBlocksContext<'_>) -> Value {
    let items: Vec<_> = (0..24).map(|i| json!({"key":format!("item-{i}"), "title":"T".repeat(80), "sub":"S".repeat(60), "text":"X".repeat(200), "facts":["F".repeat(40),"F".repeat(40)]})).collect();
    let mut spec =
        json!({"v":1,"blocks":[{"type":"cards","items":items},{"type":"cards","items":items}]});
    fill_spec(&mut spec);
    assert!(answer_blocks::validate_answer_blocks(&spec, context).is_ok());
    let bytes = serde_json::to_vec(&spec).unwrap();
    assert_eq!(bytes.len(), 24 * 1024);
    let validation = v2_perf(context);
    let start = Instant::now();
    let ops = parse(&bytes.chunks(64).collect::<Vec<_>>(), context);
    let elapsed = start.elapsed();
    assert_eq!(ops.iter().filter(|op| op.value["op"] == "item").count(), 48);
    assert_eq!(
        ops.iter()
            .filter(|op| op.value["op"] == "block_end")
            .count(),
        2
    );
    assert_eq!(ops.last().unwrap().seq, ops.len() as u64);
    let mut normalized = spec.clone();
    answer_blocks::normalize(&mut normalized);
    assert_eq!(reconstruct(&ops), normalized["blocks"]);
    // Normal 0.604 ms (PR #1358): even 10x is below visible tool/stream latency.
    json!({"bytes":bytes.len(),"micros":elapsed.as_micros(),"items":48,"ops":ops.len(),"v2":validation})
}

fn reconstruct(ops: &[AnswerBlocksDraftOp]) -> Value {
    let mut blocks: Vec<Value> = Vec::new();
    for op in ops {
        let bi = usize::try_from(op.value["bi"].as_u64().unwrap()).unwrap();
        match op.value["op"].as_str().unwrap() {
            "block" => {
                while blocks.len() <= bi {
                    blocks.push(Value::Null);
                }
                blocks[bi] = op.value["value"].clone();
            }
            "field" => {
                blocks[bi][op.value["field"].as_str().unwrap()] = op.value["value"].clone();
            }
            "tab" | "child" => {
                let ti = usize::try_from(
                    op.value
                        .get("tab")
                        .unwrap_or(&op.value["index"])
                        .as_u64()
                        .unwrap(),
                )
                .unwrap();
                if blocks[bi].get("tabs").is_none() {
                    blocks[bi]["tabs"] = json!([]);
                }
                let tabs = blocks[bi]["tabs"].as_array_mut().unwrap();
                while tabs.len() <= ti {
                    tabs.push(json!({"label":"", "blocks":[]}));
                }
                if op.value["op"] == "tab" {
                    tabs[ti]["label"] = op.value["label"].clone();
                } else {
                    tabs[ti]["blocks"]
                        .as_array_mut()
                        .unwrap()
                        .push(op.value["value"].clone());
                }
            }
            "item" => {
                let list = op.value["list"].as_str().unwrap();
                if blocks[bi].get(list).is_none() {
                    blocks[bi][list] = json!([]);
                }
                let index = usize::try_from(op.value["index"].as_u64().unwrap()).unwrap();
                let items = blocks[bi][list].as_array_mut().unwrap();
                if index < items.len() {
                    items[index] = op.value["value"].clone();
                } else {
                    items.push(op.value["value"].clone());
                }
            }
            _ => {}
        }
    }
    json!(blocks)
}

fn fill_spec(spec: &mut Value) {
    let mut remaining = 24 * 1024 - serde_json::to_vec(spec).unwrap().len();
    for block in spec["blocks"].as_array_mut().unwrap() {
        for item in block["items"].as_array_mut().unwrap() {
            for _ in 0..2 {
                if remaining == 0 {
                    return;
                }
                let mut length = (remaining - 3).min(40);
                if matches!(remaining - length - 3, 1 | 2) {
                    length -= 3;
                }
                item["facts"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!("F".repeat(length)));
                remaining -= length + 3;
            }
        }
    }
    assert_eq!(remaining, 0);
}

fn v2_perf(context: &AnswerBlocksContext<'_>) -> Value {
    let items: Vec<_> = (0..24).map(|i| json!({"title":format!("Record {i}"), "text":"x".repeat(200), "sub":"s".repeat(60), "facts":["f".repeat(40)]})).collect();
    let mut spec = json!({"v":2,"blocks":[
        {"type":"columns","blocks":[{"type":"cards","items":items},{"type":"cards","items":items}]},
        {"type":"tabs","tabs":[{"label":"First","blocks":[{"type":"cards","items":items}]},{"label":"Second","blocks":[{"type":"cards","items":[]}]}]}
    ]});
    let target = 32 * 1024;
    let prefix = "https://example.org/";
    spec["blocks"][1]["tabs"][1]["blocks"][0]["items"] = json!([{"title":"x","source":prefix}]);
    // Fill using bounded text and source fields; assert the exact serialized cap.
    for block in [
        "/blocks/0/blocks/0",
        "/blocks/0/blocks/1",
        "/blocks/1/tabs/0/blocks/0",
    ] {
        for i in 0..24 {
            let remaining = target - serde_json::to_vec(&spec).unwrap().len();
            if remaining == 0 {
                break;
            }
            let overhead = 12 + prefix.len();
            if remaining < overhead {
                continue;
            }
            spec.pointer_mut(block).unwrap()["items"][i]["source"] = json!(format!(
                "{prefix}{}",
                "x".repeat((remaining - overhead).min(2048 - prefix.len()))
            ));
        }
    }
    assert_eq!(serde_json::to_vec(&spec).unwrap().len(), target);
    let start = Instant::now();
    assert!(answer_blocks::validate_answer_blocks(&spec, context).is_ok());
    let elapsed = start.elapsed();
    assert_eq!(spec["blocks"].as_array().unwrap().len(), 2);
    json!({"bytes":serde_json::to_vec(&spec).unwrap().len(),"validator_micros":elapsed.as_micros()})
}
