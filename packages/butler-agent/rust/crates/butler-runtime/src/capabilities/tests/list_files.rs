use serde_json::{Value, json};

use super::{CapabilityInvocation, Fixture};

async fn native(fixture: &Fixture, call: &Value) -> Value {
    fixture
        .capabilities
        .invoke(
            "list_files",
            CapabilityInvocation {
                call,
                workspace_reference: None,
                workspace_path: Some(&fixture.root),
                butler_data: &fixture.root,
                protected_ledger_roots: &[],
                allowed_tools_and_effects: None,
                mutation_scope: None,
                installation_root: None,
            },
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn discovery_pages_skip_sensitive_files_and_reads_admitted_file() {
    let fixture = Fixture::new();
    std::fs::create_dir_all(fixture.root.join("src")).unwrap();
    std::fs::create_dir_all(fixture.root.join(".git")).unwrap();
    std::fs::create_dir_all(fixture.root.join("data")).unwrap();
    fixture.write("src/a.ts", b"first");
    fixture.write("src/b.ts", b"second");
    fixture.write("src/private.pem", b"private");
    fixture.write(".git/hidden.ts", b"private");
    let mut call = json!({"arguments":{"include_globs":["**/*.ts"],"max_results":1}});
    let first = native(&fixture, &call).await;
    assert_eq!(first["ok"], true);
    assert_eq!(first["truncated"], true);
    assert_eq!(first["files"][0]["path"], "src/a.ts");
    let cursor = first["next_cursor"].clone();
    assert!(cursor.is_string());
    call["arguments"]["cursor"] = cursor;
    let second = native(&fixture, &call).await;
    assert_eq!(second["ok"], true);
    assert_eq!(second["files"][0]["path"], "src/b.ts");
    assert_eq!(second["truncated"], true);
    assert!(second["next_cursor"].is_string());
    let read = fixture
        .invoke(
            &json!({"arguments":{"requests":[{"path":"src/b.ts"}]}}),
            None,
        )
        .await;
    assert_eq!(read["files"][0]["content"], "second");
    fixture.files.close().await;
}
