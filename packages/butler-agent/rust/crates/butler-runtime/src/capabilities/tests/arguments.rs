use serde_json::json;

use super::Fixture;

#[tokio::test]
async fn number_coercion_limits_and_guard_cases_have_explicit_results() {
    let fixture = Fixture::new();
    fixture.write("n.txt", "A😀B\nZ".as_bytes());
    fixture.write("\u{85}n.txt", b"non-js-whitespace");
    let clamped = fixture
        .invoke(
            &json!({ "arguments": { "requests": [{ "path": "n.txt", "max_bytes": null }], "max_total_bytes": false } }),
            None,
        )
        .await;
    assert_eq!(clamped["files"][0]["content"], "A");
    assert_eq!(clamped["output_bytes"], 1);

    let array_number = fixture
        .invoke(
            &json!({ "arguments": { "requests": [{ "path": "n.txt", "max_bytes": [] }], "max_total_bytes": "2" } }),
            None,
        )
        .await;
    assert_eq!(array_number["files"][0]["content"], "A");
    assert!(array_number["next_cursor"].is_string());

    let line_range = fixture
        .invoke(
            &json!({ "arguments": { "requests": [{ "path": "n.txt", "start_line": "", "limit_lines": ["2"] }] } }),
            None,
        )
        .await;
    assert_eq!(line_range["files"][0]["content"], "A😀B\nZ");
    assert_eq!(line_range["files"][0]["start_line"], 1);
    assert_eq!(line_range["files"][0]["end_line"], 2);

    let hex_budget = fixture
        .invoke(
            &json!({ "arguments": { "requests": [{ "path": "n.txt", "max_bytes": "0x2" }] } }),
            None,
        )
        .await;
    assert_eq!(hex_budget["files"][0]["content"], "A");

    let blank_cursor = fixture
        .invoke(
            &json!({ "arguments": { "requests": [{ "path": "n.txt" }], "cursor": " " } }),
            None,
        )
        .await;
    assert_eq!(blank_cursor["files"][0]["content"], "A😀B\nZ");
    let invalid_cursor = fixture
        .invoke(
            &json!({ "arguments": { "requests": [{ "path": "n.txt" }], "cursor": "not-base64!" } }),
            None,
        )
        .await;
    assert_eq!(invalid_cursor["error"], "invalid_cursor");

    let json_arguments = fixture
        .invoke(
            &json!({ "arguments": "{\"requests\":[{\"path\":\"n.txt\"}] }" }),
            None,
        )
        .await;
    assert_eq!(json_arguments["files"][0]["content"], "A😀B\nZ");

    for path in ["../n.txt", ".env"] {
        let rejected = fixture
            .invoke(
                &json!({ "arguments": { "requests": [{ "path": path }] } }),
                None,
            )
            .await;
        assert_eq!(rejected["files"][0]["ok"], false, "path: {path}");
    }
    let unicode_space = fixture
        .invoke(
            &json!({ "arguments": { "requests": [{ "path": "\u{85}n.txt" }] } }),
            None,
        )
        .await;
    assert_eq!(unicode_space["files"][0]["content"], "non-js-whitespace");
    fixture.files.close().await;
}

#[tokio::test]
async fn invalid_json_and_invalid_shape_have_distinct_public_codes() {
    let fixture = Fixture::new();
    let malformed = fixture.invoke(&json!({ "arguments": "{" }), None).await;
    assert_eq!(malformed["error"], "invalid_arguments_json");
    assert_eq!(
        malformed["evidence_capability_receipts"][0]["capability"],
        "limitation_recorded"
    );
    let wrong_shape = fixture.invoke(&json!({ "arguments": "[]" }), None).await;
    assert_eq!(wrong_shape["error"], "invalid_arguments_shape");
    fixture.files.close().await;
}
