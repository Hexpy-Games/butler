//! Format pin of the legacy index receipts: the provenance line, the
//! vector stats file and the memory log line.
//!
//! The golden in `fixtures/receipts.json` was generated from the
//! pre-typing `json!` receipt code. Times are normalized. Run with
//! `BUTLER_BLESS_FORMAT=1` to regenerate it only when a format change is
//! intended.

use std::fs;
use std::path::Path;

use super::receipts::{LegacyReceiptInput, record, record_legacy};

#[test]
fn receipts_keep_their_bytes() {
    let root = std::env::temp_dir().join(format!("butler-receipts-pin-{}", uuid::Uuid::new_v4()));
    let memory = root.join("cognition/memory");
    fs::create_dir_all(memory.join("db")).unwrap();
    let temp = memory.join("db/vector-stats.json.tmp-1");
    record(&root, &memory, "", "hot_session", 3, 7, &temp).unwrap();
    let hot_stats = fs::read_to_string(memory.join("db/vector-stats.json")).unwrap();
    let temp = memory.join("db/vector-stats.json.tmp-2");
    record_legacy(LegacyReceiptInput {
        data_root: &root,
        memory_root: &memory,
        text: "",
        session_id: "legacy_session",
        source_session_id: "source \"quoted\"",
        project: "alpha",
        source: "session",
        topic: Some("Topic ✓"),
        strict: false,
        chunk_count: 2,
        row_count: 9,
        temp: &temp,
    })
    .unwrap();
    let legacy_stats = fs::read_to_string(memory.join("db/vector-stats.json")).unwrap();
    let provenance = fs::read_to_string(memory.join("db/session-provenance.jsonl")).unwrap();
    let log = fs::read_to_string(root.join("logs/memory.log")).unwrap();
    fs::remove_dir_all(&root).unwrap();
    let pinned = serde_json::json!({
        "hot_stats": hot_stats,
        "legacy_stats": legacy_stats,
        "provenance": provenance,
        "log": log,
    });
    let text = butler_core::json::pretty(&pinned);
    let text = regex::Regex::new(r"\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d{3}Z)?")
        .unwrap()
        .replace_all(&text, "<time>")
        .into_owned();
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/cognition/hot_cache/fixtures/receipts.json");
    if std::env::var_os("BUTLER_BLESS_FORMAT").is_some() {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &text).unwrap();
        return;
    }
    let expected = fs::read_to_string(&path).unwrap();
    assert_eq!(text, expected, "legacy receipt format changed");
}
