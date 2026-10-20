use super::*;

// test-category: security
#[tokio::test]
async fn registered_read_preserves_bom_line_endings_errors_and_continuation() {
    contained_read_file_refusals_preserve_guard_fields_and_safe_explanations().await;
    let fixture = Fixture::new();
    assert_eq!(
        fixture.capabilities.registered_names(),
        &[
            "read_file",
            "write_file",
            "edit_file",
            "list_files",
            "grep_files",
            "list_skills",
            "load_skill",
            "read_skill_file",
        ]
    );
    assert_eq!(
        fixture.capabilities.definition("read_file").unwrap()["name"],
        "read_file"
    );
    fixture.write("bom.txt", b"\xef\xbb\xbfalpha\r\nbeta\rgamma\n");
    fixture.write("emoji.txt", "😀next\n".as_bytes());
    fixture.write("invalid.txt", &[b'a'; 10]);
    let mut invalid = vec![b'a'; 70_000];
    invalid.push(0xff);
    fixture.write("invalid.txt", &invalid);
    let first_call = json!({ "arguments": { "requests": [{ "path": "bom.txt", "max_bytes": 6 }, { "path": "missing.txt" }] } });
    let first = fixture.invoke(&first_call, None).await;
    assert_eq!(first["files"][0]["content"], "alpha\n");
    assert_eq!(first["files"][1]["pending"], true);
    let continued = json!({ "arguments": { "requests": first_call["arguments"]["requests"], "cursor": first["next_cursor"] } });
    let rest = fixture.invoke(&continued, None).await;
    assert_eq!(rest["files"][0]["content"], "beta\ng");
    let final_call = json!({ "arguments": { "requests": first_call["arguments"]["requests"], "cursor": rest["next_cursor"] } });
    let final_page = fixture.invoke(&final_call, None).await;
    assert_eq!(final_page["files"][0]["content"], "amma\n");
    assert_eq!(final_page["files"][1]["error"], "not_found");

    let utf8_edges = fixture
        .invoke(
            &json!({ "arguments": { "requests": [{ "path": "emoji.txt", "max_bytes": 3 }, { "path": "invalid.txt" }] } }),
            None,
        )
        .await;
    assert_eq!(
        utf8_edges["files"][0]["error"],
        "max_bytes_too_small_for_utf8"
    );
    assert_eq!(utf8_edges["files"][1]["error"], "invalid_utf8");

    let aggregate = fixture
        .invoke(
            &json!({ "arguments": { "requests": [{ "path": "bom.txt", "start_line": "2", "limit_lines": false }, { "path": "emoji.txt" }], "max_total_bytes": 2 } }),
            None,
        )
        .await;
    assert_eq!(aggregate["files"][0]["content"], "be");
    assert_eq!(aggregate["files"][0]["truncated"], true);
    assert_eq!(aggregate["files"][1]["pending"], true);

    let input_alias = fixture
        .invoke(
            &json!({ "input": { "requests": [{ "path": "invalid.txt", "max_bytes": 1 }] } }),
            None,
        )
        .await;
    assert_eq!(input_alias["files"][0]["error"], "invalid_utf8");
    fixture.files.close().await;
}

async fn contained_read_file_refusals_preserve_guard_fields_and_safe_explanations() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    fixture.write(".env", b"private-fixture");
    outside.write("outside.txt", b"outside");
    let protected = fixture.root.join("ledger");
    std::fs::create_dir_all(&protected).unwrap();
    std::fs::write(protected.join("record"), b"ledger").unwrap();
    std::fs::create_dir(fixture.root.join("folder")).unwrap();
    let mut cases = vec![
        (
            "../outside.txt",
            "path_escape",
            "The requested path is outside the permitted scope.",
        ),
        (
            ".env",
            "sensitive_path_blocked",
            "The requested path contains sensitive or credential files.",
        ),
        (
            "ledger/record",
            "protected_path",
            "Project Ledger paths require dedicated tools.",
        ),
        ("folder", "not_a_file", "The requested path is a directory."),
        (
            "missing.txt",
            "not_found",
            "The requested path was not found.",
        ),
    ];
    if secure_fs::NO_FOLLOW {
        secure_fs::symlink(
            &outside.root.join("outside.txt"),
            &fixture.root.join("link"),
        )
        .unwrap();
        cases.push((
            "link",
            "symlink_escape",
            "The requested path is outside the permitted scope.",
        ));
    }
    for (path, code, message) in cases {
        let call = json!({"arguments":{"requests":[{"path":path}]}});
        let result = fixture
            .capabilities
            .invoke(
                "read_file",
                CapabilityInvocation {
                    contained: true,
                    call: &call,
                    workspace_reference: None,
                    workspace_path: Some(&fixture.root),
                    butler_data: &fixture.root,
                    protected_ledger_roots: std::slice::from_ref(&protected),
                    allowed_tools_and_effects: None,
                    mutation_scope: None,
                    installation_root: None,
                },
            )
            .await
            .unwrap();
        let file = &result["files"][0];
        assert_eq!(file["error"], code, "{result}");
        assert_eq!(file["message"], message, "{result}");
        assert_eq!(file["workspace_root"], json!(fixture.root), "{result}");
        assert_eq!(file["guard"]["workspace_root"], json!(fixture.root));
        assert_eq!(file["guard"]["ok"], false);
        assert_ne!(file["recovery_hint"].as_str().unwrap(), "");
        for field in ["message", "recovery_hint"] {
            let text = file[field].as_str().unwrap();
            assert!(!text.contains(".env") && !text.contains(outside.root.to_str().unwrap()));
        }
        let guard_message = file["guard"]["message"].as_str().unwrap();
        assert!(!guard_message.contains(".env"));
        assert!(!guard_message.contains(outside.root.to_str().unwrap()));
    }
    fixture.files.close().await;
    outside.files.close().await;
}
