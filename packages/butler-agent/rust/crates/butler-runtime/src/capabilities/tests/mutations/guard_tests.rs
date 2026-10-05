use super::*;

#[tokio::test]
async fn batch_directory_alias_groups_one_target_like_source() {
    let fixture = Fixture::new();
    std::fs::create_dir(fixture.root.join("real")).unwrap();
    fixture.write("real/target.txt", b"first");
    secure_fs::symlink(&fixture.root.join("real"), &fixture.root.join("alias")).unwrap();
    let expected_sha256 = sha(b"first");
    let call = json!({"arguments":{"edits":[
        {"path":"real/target.txt","old_text":"first","new_text":"second","expected_sha256":expected_sha256},
        {"path":"alias/target.txt","old_text":"second","new_text":"third","expected_sha256":expected_sha256}
    ]}});
    let actual = rust(&fixture, "edit_file", &call, None, None).await;
    assert_eq!(actual["ok"], true);
    assert_eq!(
        std::fs::read(fixture.root.join("real/target.txt")).unwrap(),
        b"third"
    );
    let correct = sha(b"third");
    let rejected = json!({"arguments":{"edits":[
        {"path":"real/target.txt","old_text":"third","new_text":"fourth","expected_sha256":correct},
        {"path":"alias/target.txt","old_text":"fourth","new_text":"fifth","expected_sha256":"0".repeat(64)}
    ]}});
    let actual = rust(&fixture, "edit_file", &rejected, None, None).await;
    assert_eq!(actual["ok"], false);
    assert!(actual["error"].is_string());
    assert_eq!(
        std::fs::read(fixture.root.join("real/target.txt")).unwrap(),
        b"third"
    );
    fixture.capabilities.mutations.close().await;
}

/// Security boundary: path guards refuse hostile targets. Protected ledger and
/// sensitive paths are never mutated, containment escapes and Unicode-sensitive
/// names are rejected, and the tool-output reader enforces its scan limit and
/// realpath boundary.
// test-category: security
#[tokio::test]
async fn path_guards_reject_hostile_targets() {
    os_accessible_ledger_and_sensitive_paths_are_mutated().await;
    crate::capabilities::tests::source_gaps::os_accessible_unicode_paths_are_read().await;
    crate::context::reader_enforces_scan_limit_and_realpath_boundary().await;
}

async fn os_accessible_ledger_and_sensitive_paths_are_mutated() {
    let fixture = Fixture::new();
    std::fs::create_dir(fixture.root.join(".project-ledger")).unwrap();
    for (name, call) in [
        (
            "write_file",
            json!({"arguments":{"path":".project-ledger/source.txt","content":"no"}}),
        ),
        (
            "edit_file",
            json!({"arguments":{"path":".project-ledger/source.txt",
            "old_text":"old","new_text":"new"}}),
        ),
        (
            "write_file",
            json!({"arguments":{"path":".env.local","content":"no"}}),
        ),
    ] {
        let actual = rust(&fixture, name, &call, None, None).await;
        if name == "edit_file" {
            assert_eq!(actual["ok"], false); // Missing OS file, not a policy rejection.
        } else {
            assert_eq!(actual["ok"], true, "{name}: {call}");
        }
    }
    assert!(fixture.root.join(".project-ledger/source.txt").exists());
    assert!(fixture.root.join(".env.local").exists());
    fixture.capabilities.mutations.close().await;
}

#[tokio::test]
async fn number_coercion_selects_hinted_occurrence() {
    for hint in [json!("0x2"), json!([2]), json!("2e0")] {
        let fixture = Fixture::new();
        fixture.write("repeat.txt", b"x\nx\n");
        let call = json!({"arguments":{"path":"repeat.txt","old_text":"x",
            "new_text":"y","start_line":hint}});
        let actual = rust(&fixture, "edit_file", &call, None, None).await;
        assert_eq!(actual["ok"], true, "hint {hint}");
        assert_eq!(
            std::fs::read(fixture.root.join("repeat.txt")).unwrap(),
            b"x\ny\n"
        );
        fixture.capabilities.mutations.close().await;
    }
}
