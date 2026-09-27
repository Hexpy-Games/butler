use std::sync::Arc;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{CapabilityInvocation, Fixture};
use crate::workspace::WorkspaceMutations;

async fn rust(
    fixture: &Fixture,
    name: &str,
    call: &Value,
    allowed: Option<&[String]>,
    scope: Option<&[String]>,
) -> Value {
    fixture
        .capabilities
        .invoke(
            name,
            CapabilityInvocation {
                call,
                workspace_reference: None,
                workspace_path: Some(&fixture.root),
                butler_data: &fixture.root,
                protected_ledger_roots: &[],
                allowed_tools_and_effects: allowed,
                mutation_scope: scope,
                installation_root: None,
            },
        )
        .await
        .unwrap()
}

fn sha(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

#[tokio::test]
async fn registry_creates_overwrites_and_edits_workspace_files() {
    let fixture = Fixture::new();
    let create = json!({"arguments":{"path":"sample.txt","content":"\u{feff}one\r\ntwo\r\n"}});
    let created = rust(&fixture, "write_file", &create, None, None).await;
    assert_eq!(created["ok"], true);
    assert_eq!(
        std::fs::read(fixture.root.join("sample.txt")).unwrap(),
        "\u{feff}one\r\ntwo\r\n".as_bytes()
    );
    let before_sha = created["after_sha256"].as_str().unwrap();
    let edit = json!({"arguments":{"path":"sample.txt","old_text":"two","new_text":"second",
        "expected_sha256":before_sha,"start_line":2}});
    let edited = rust(&fixture, "edit_file", &edit, None, None).await;
    assert_eq!(edited["ok"], true);
    assert_eq!(
        std::fs::read(fixture.root.join("sample.txt")).unwrap(),
        "\u{feff}one\r\nsecond\r\n".as_bytes()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            fixture.root.join("sample.txt"),
            std::fs::Permissions::from_mode(0o640),
        )
        .unwrap();
    }
    let overwrite = json!({"arguments":{"path":"sample.txt","content":"complete\n",
        "overwrite":true,"expected_sha256":edited["after_sha256"]}});
    let overwritten = rust(&fixture, "write_file", &overwrite, None, None).await;
    assert_eq!(overwritten["ok"], true);
    assert_eq!(
        std::fs::read(fixture.root.join("sample.txt")).unwrap(),
        b"complete\n"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(fixture.root.join("sample.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o640);
    }
    fixture.capabilities.mutations.close().await;
}

#[tokio::test]
async fn write_file_creates_empty_files_and_admitted_parent_directories() {
    {
        let fixture = Fixture::new();
        let call = json!({"arguments":{"path":"empty.txt","content":""}});
        let actual = rust(&fixture, "write_file", &call, None, None).await;
        assert_eq!(actual["ok"], true);
        assert_eq!(actual["changed_file"]["file_created"], true);
        assert_eq!(actual["changed_file"]["lines"], json!([]));
        assert_eq!(std::fs::read(fixture.root.join("empty.txt")).unwrap(), b"");
        fixture.capabilities.mutations.close().await;
    }
    {
        let fixture = Fixture::new();
        let call = json!({"arguments":{"path":"new/deep/file.txt","content":"created",
            "create_parents":true}});
        let actual = rust(&fixture, "write_file", &call, None, None).await;
        assert_eq!(actual["ok"], true);
        assert_eq!(
            std::fs::read(fixture.root.join("new/deep/file.txt")).unwrap(),
            b"created"
        );
        fixture.capabilities.mutations.close().await;
    }
}

#[tokio::test]
async fn nul_after_binary_prefix_remains_editable_like_source() {
    let fixture = Fixture::new();
    let mut bytes = vec![b'a'; 4096];
    bytes.extend_from_slice(b"\0z");
    fixture.write("late-nul.txt", &bytes);
    let call = json!({"arguments":{"path":"late-nul.txt","old_text":"z","new_text":"q"}});
    let actual = rust(&fixture, "edit_file", &call, None, None).await;
    assert_eq!(actual["ok"], true);
    bytes[4097] = b'q';
    assert_eq!(
        std::fs::read(fixture.root.join("late-nul.txt")).unwrap(),
        bytes
    );
    fixture.capabilities.mutations.close().await;
}

#[tokio::test]
async fn admission_and_scope_precedence_is_branch_specific() {
    let fixture = Fixture::new();
    let none: [String; 0] = [];
    let scope = ["other/".to_owned()];
    let write = json!({"arguments":{"path":"blocked.txt","content":"value"}});
    let single = json!({"arguments":{"path":"blocked.txt","old_text":"a","new_text":"b"}});
    let batch = json!({"arguments":{"edits":[
        {"path":"blocked.txt","old_text":"a","new_text":"b","expected_sha256":"0".repeat(64)},
        {"path":"blocked.txt","old_text":"b","new_text":"c","expected_sha256":"0".repeat(64)}]}});
    assert_eq!(
        rust(&fixture, "write_file", &write, Some(&none), Some(&scope)).await["error"],
        "tool_not_admitted"
    );
    assert_eq!(
        rust(&fixture, "edit_file", &single, Some(&none), Some(&scope)).await["error"],
        "invalid_arguments"
    );
    assert_eq!(
        rust(&fixture, "edit_file", &batch, Some(&none), Some(&scope)).await["error"],
        "tool_not_admitted"
    );
    assert!(!fixture.root.join("blocked.txt").exists());
    fixture.capabilities.mutations.close().await;
}

#[tokio::test]
async fn dropped_caller_still_completes_and_close_drains() {
    let fixture = Fixture::new();
    let owner: Arc<WorkspaceMutations> = Arc::clone(&fixture.capabilities.mutations);
    let command = crate::workspace::MutationCommand::Write(crate::workspace::WriteMutation {
        context: crate::workspace::MutationContext {
            root: fixture.root.clone(),
            relative_only: false,
            installation_root: None,
            protected_roots: Vec::new(),
        },
        path: "detached.txt".into(),
        content: "completed".into(),
        overwrite: false,
        create_parents: false,
        expected_sha256: None,
    });
    let receiver = owner.submit(command).unwrap();
    drop(receiver);
    owner.close().await;
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("detached.txt")).unwrap(),
        "completed"
    );
    assert_eq!(owner.active_count(), 0);
}

#[tokio::test]
async fn ordered_batch_repeated_target_and_net_unchanged() {
    let fixture = Fixture::new();
    fixture.write("a.txt", b"alpha\nbeta\n");
    fixture.write("b.txt", b"hold\n");
    let a_sha = sha(b"alpha\nbeta\n");
    let b_sha = sha(b"hold\n");
    let call = json!({"arguments":{"edits":[
        {"path":"a.txt","old_text":"alpha","new_text":"first","expected_sha256":a_sha},
        {"path":"a.txt","old_text":"first","new_text":"final","expected_sha256":a_sha},
        {"path":"b.txt","old_text":"hold","new_text":"temporary","expected_sha256":b_sha},
        {"path":"b.txt","old_text":"temporary","new_text":"hold","expected_sha256":b_sha}
    ]}});
    let result = rust(&fixture, "edit_file", &call, None, None).await;
    assert_eq!(result["ok"], true);
    assert_eq!(
        std::fs::read(fixture.root.join("a.txt")).unwrap(),
        b"final\nbeta\n"
    );
    assert_eq!(
        std::fs::read(fixture.root.join("b.txt")).unwrap(),
        b"hold\n"
    );
    fixture.capabilities.mutations.close().await;
}

#[tokio::test]
async fn preflight_rejections_do_not_partially_mutate_workspace() {
    let fixture = Fixture::new();
    fixture.write("existing.txt", b"old");
    fixture.write("invalid.txt", &[0xff, 0xfe]);
    let mut late_invalid = vec![b'a'; 5000];
    late_invalid.push(0xff);
    fixture.write("late-invalid.txt", &late_invalid);
    fixture.write("binary.txt", b"a\0b");
    let calls = [
        (
            "write_file",
            json!({"arguments":{"path":"null.txt","content":"new","overwrite":null}}),
        ),
        (
            "write_file",
            json!({"arguments":{"path":"null.txt","content":"new","expected_sha256":null}}),
        ),
        (
            "write_file",
            json!({"arguments":{"path":"existing.txt","content":"new"}}),
        ),
        (
            "write_file",
            json!({"arguments":{"path":"existing.txt","content":"new","overwrite":true}}),
        ),
        (
            "write_file",
            json!({"arguments":{"path":"nested/file.txt","content":"new",
            "create_parents":true,"expected_sha256":"0".repeat(64)}}),
        ),
        (
            "edit_file",
            json!({"arguments":{"path":"existing.txt","old_text":"missing","new_text":"new"}}),
        ),
        (
            "edit_file",
            json!({"arguments":{"path":"existing.txt","old_text":"missing","new_text":"new","start_line":2}}),
        ),
        (
            "edit_file",
            json!({"arguments":{"path":"existing.txt","old_text":"old","new_text":"new","expected_sha256":"0".repeat(64)}}),
        ),
        (
            "edit_file",
            json!({"arguments":{"path":"invalid.txt","old_text":"old","new_text":"new"}}),
        ),
        (
            "edit_file",
            json!({"arguments":{"path":"late-invalid.txt","old_text":"old","new_text":"new"}}),
        ),
        (
            "edit_file",
            json!({"arguments":{"path":"binary.txt","old_text":"a","new_text":"new"}}),
        ),
        (
            "edit_file",
            json!({"arguments":{"edits":[
            {"path":"existing.txt","old_text":"old","new_text":"new","expected_sha256":"0".repeat(64)},
            {"path":"absent.txt","old_text":"old","new_text":"new","expected_sha256":"0".repeat(64)}]}}),
        ),
    ];
    for (name, call) in &calls {
        let actual = rust(&fixture, name, call, None, None).await;
        assert_eq!(actual["ok"], false, "{name}: {call}");
        assert!(actual["error"].is_string(), "{name}: {call}");
    }
    assert!(!fixture.root.join("nested").exists());
    assert_eq!(
        std::fs::read(fixture.root.join("existing.txt")).unwrap(),
        b"old"
    );
    assert!(!fixture.root.join("absent.txt").exists());
    assert!(!fixture.root.join("null.txt").exists());
    fixture.capabilities.mutations.close().await;
}

mod guard_tests;
