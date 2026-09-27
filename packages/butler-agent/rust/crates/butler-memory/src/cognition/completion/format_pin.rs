//! Byte-level format pin of completion observations and the sync queue.
//!
//! The golden in `fixtures/format/published.json` was generated from the
//! pre-typing `serde_json::Value` publisher. Run with `BUTLER_BLESS_FORMAT=1`
//! to regenerate it only when a format change is intended.

use std::{fs, path::Path, sync::Arc};

use serde_json::{Value, json};

use super::{CompletionNotice, CompletionPublisher};
use crate::cognition::CognitionPathEnvironment;

fn notice(turn: &str, generation: f64, project: Option<&str>) -> CompletionNotice {
    CompletionNotice {
        project_id: project.map(str::to_owned),
        runtime_session_id: " runtime-1 ".into(),
        conversation_session_id: "session-1".into(),
        conversation_turn_id: turn.into(),
        inbound_message_id: "in-1".into(),
        outbound_message_id: "out-1".into(),
        outcome_generation: generation,
        completed_at: "2026-02-03T04:05:06.007Z".into(),
    }
}

fn files(root: &Path) -> Value {
    let mut entries = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        for entry in fs::read_dir(&directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else if path
                .extension()
                .is_some_and(|ext| ext == "json" || ext == "jsonl")
            {
                let name = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                entries.push((name, fs::read_to_string(&path).unwrap()));
            }
        }
    }
    entries.sort();
    Value::Object(
        entries
            .into_iter()
            .map(|(name, text)| (name, Value::String(text)))
            .collect(),
    )
}

#[test]
fn observations_and_sync_requests_keep_their_bytes() {
    let root = std::env::temp_dir().join(format!("butler-completion-pin-{}", uuid::Uuid::new_v4()));
    let publisher = CompletionPublisher::new(
        &root,
        &CognitionPathEnvironment::default(),
        Arc::new(|| "2026-02-03T04:05:07.000Z".into()),
    );
    let outcomes = [
        publisher.publish(&notice("turn-1", 3.0, Some(" project-a "))),
        publisher.publish(&notice("turn-1", 3.0, Some(" project-a "))),
        publisher.publish(&notice("turn-2", 7.9, None)),
        publisher.publish(&notice("turn-3", 0.0, Some("  "))),
        publisher.publish(&notice("turn-4", f64::INFINITY, None)),
        publisher.publish(&notice("turn-5", 1e21, None)),
    ]
    .into_iter()
    .map(|outcome| match outcome {
        Ok(()) => Value::Null,
        Err(error) => Value::String(error.code().into()),
    })
    .collect::<Vec<_>>();
    let pinned = json!({
        "outcomes": outcomes,
        "files": files(&root),
    });
    let _ = fs::remove_dir_all(&root);
    let text = butler_core::json::pretty(&pinned);
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/cognition/completion/fixtures/format/published.json");
    if std::env::var_os("BUTLER_BLESS_FORMAT").is_some() {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &text).unwrap();
        return;
    }
    let expected = fs::read_to_string(&path).unwrap();
    assert_eq!(text, expected, "completion format changed");
}
