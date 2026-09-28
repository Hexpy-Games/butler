use super::{path, *};

/// Security boundary: write-effect inputs and targets (`..`, mixed
/// separators, absolute paths) normalize inside the workspace or are refused.
// test-category: security
#[test]
fn write_effect_inputs_and_targets_normalize_inside_the_workspace() {
    let workspace = std::path::Path::new("/tmp/butler-workspace-fixture");
    for (input, expected) in [
        (
            json!({"path":"a\\b","content":"x"}),
            Ok(json!({"path":"a/b","content":"x","create_parents":false})),
        ),
        (
            json!({"path":"a//b","content":"x","create_parents":true}),
            Ok(json!({"path":"a/b","content":"x","create_parents":true})),
        ),
        (
            json!({"path":"/tmp/butler-workspace-fixture/a","content":"x"}),
            Ok(json!({"path":"a","content":"x","create_parents":false})),
        ),
        (
            json!({"path":"a/","content":"x"}),
            Ok(json!({"path":"a/","content":"x","create_parents":false})),
        ),
        (
            json!({"path":"../a","content":"x"}),
            Err("write_file effect path cannot traverse a parent directory"),
        ),
        (
            json!({"path":"a","content":"x","create_parents":null}),
            Err("write_file effect create_parents must be a boolean"),
        ),
        (
            json!({"path":"a","content":1}),
            Err("write_file effect content must be a string"),
        ),
    ] {
        match expected {
            Ok(normalized) => assert_eq!(
                serde_json::to_value(path::input(&input, workspace).unwrap()).unwrap(),
                normalized,
                "{input}"
            ),
            Err(message) => assert_eq!(
                path::input(&input, workspace).unwrap_err().message(),
                message,
                "{input}"
            ),
        }
    }
    for (target, expected) in [
        ("workspace:a\\b", Ok("workspace:a/b")),
        ("workspace:a//b", Ok("workspace:a/b")),
        ("workspace:a/", Ok("workspace:a/")),
        (
            "workspace:../a",
            Err("write_file effect path cannot traverse a parent directory"),
        ),
        (
            "workspace:/a",
            Err("write_file effect path must be workspace-relative"),
        ),
        (
            "bad:a",
            Err("write_file effect target must use workspace:<relative-path>"),
        ),
    ] {
        match expected {
            Ok(normalized) => assert_eq!(path::target(target).unwrap(), normalized),
            Err(message) => assert_eq!(path::target(target).unwrap_err().message(), message),
        }
    }
}

/// KEEP: the journaled write_file input (identity-hashed) is byte-stable.
pub(crate) fn write_effect_normalized_input_is_byte_stable() {
    let workspace = std::path::Path::new("/tmp/butler-workspace-fixture");
    let input = json!({"expected_sha256":"A".repeat(64),"overwrite":true,"content":"x",
        "create_parents":true,"path":"a/b"});
    let normalized = serde_json::to_value(path::input(&input, workspace).unwrap()).unwrap();
    assert_eq!(
        butler_core::json::stringify(&normalized).unwrap(),
        format!(
            r#"{{"path":"a/b","content":"x","create_parents":true,"overwrite":true,"expected_sha256":"{}"}}"#,
            "a".repeat(64)
        )
    );
}
