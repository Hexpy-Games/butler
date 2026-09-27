//! KEEP: format pins for the journaled edit_file input, the registered
//! tool's arguments and the applied receipt.

use std::sync::Arc;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::*;

struct Unused;
impl RegisteredEditPort for Unused {
    fn edit(&self, _prepared: PreparedEdit) -> EffectFuture<'_, Value> {
        Box::pin(async { Ok(Value::Null) })
    }
}

fn sha(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn entry(path: &str, before: &str, after: &str) -> Value {
    json!({"after_sha256":after,"new_text":"new","path":path,"old_text":"old",
        "start_line":3,"before_sha256":before})
}

#[tokio::test]
async fn edit_input_prepared_edit_and_receipt_are_byte_stable() {
    let root = std::env::temp_dir().join(format!("butler-edit-pin-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("a.txt"), "after").unwrap();
    let adapter = WorkspaceFileEditEffectAdapter::new(
        crate::workspace::EffectFileScope {
            workspace: root.clone(),
            butler_data: root.join("data"),
            protected_roots: vec![],
            installation_root: None,
        },
        Arc::new(Unused),
    );
    let (before, after) = (sha("before"), sha("after"));
    let single = adapter
        .normalize_input(&entry("a.txt", &before, &after))
        .unwrap();
    assert_eq!(
        butler_core::json::stringify(&single).unwrap(),
        format!(
            r#"{{"path":"a.txt","start_line":3,"old_text":"old","new_text":"new","before_sha256":"{before}","after_sha256":"{after}"}}"#
        )
    );
    let batch = adapter
        .normalize_input(
            &json!({"edits":[entry("a.txt", &before, &after), entry("b.txt", &before, &after)]}),
        )
        .unwrap();
    assert_eq!(
        butler_core::json::stringify(&batch).unwrap(),
        format!(
            r#"{{"edits":[{{"path":"a.txt","start_line":3,"old_text":"old","new_text":"new","before_sha256":"{before}","after_sha256":"{after}"}},{{"path":"b.txt","start_line":3,"old_text":"old","new_text":"new","before_sha256":"{before}","after_sha256":"{after}"}}]}}"#
        )
    );
    let prepared = normalized::EditInput::decode(&batch).unwrap().prepared();
    assert_eq!(
        butler_core::json::stringify(&serde_json::to_value(prepared).unwrap()).unwrap(),
        format!(
            r#"{{"edits":[{{"path":"a.txt","start_line":3,"old_text":"old","new_text":"new","expected_sha256":"{before}"}},{{"path":"b.txt","start_line":3,"old_text":"old","new_text":"new","expected_sha256":"{before}"}}]}}"#
        )
    );
    let signal = CancellationToken::new();
    let AdapterOutcome::Applied(receipt) = adapter
        .reconcile("workspace:a.txt", &single, "key", &signal, 1, None)
        .await
        .unwrap()
    else {
        panic!("expected applied");
    };
    assert_eq!(
        butler_core::json::stringify(&receipt.read::<Value>().unwrap()).unwrap(),
        format!(
            r#"{{"ok":true,"effect":"workspace_file_edit","path":"a.txt","start_line":3,"bytes":5,"before_sha256":"{before}","after_sha256":"{after}","target_observed":true}}"#
        )
    );
    std::fs::remove_dir_all(&root).unwrap();
}
