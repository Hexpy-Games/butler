use super::*;

#[tokio::test]
async fn registered_read_preserves_bom_line_endings_errors_and_continuation() {
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
