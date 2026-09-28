use super::*;

#[test]
fn batch_recovery_preserves_file_hash_consistency_and_path_order() {
    let before = "a".repeat(64);
    let after = "b".repeat(64);
    let entries = json!([
        {"path":"src\\main.rs","startLine":1,"beforeSha256":before.to_uppercase(),"afterSha256":after},
        {"path":"src/main.rs","startLine":3,"beforeSha256":before,"afterSha256":after}
    ]);
    let normalized = super::recovery::normalize_entries(&entries).unwrap();
    assert_eq!(normalized[0].path, "src/main.rs");
    assert_eq!(normalized[1].start_line, 3);
    assert_eq!(normalized[0].before_sha256, before);
    let mut conflict = entries;
    conflict[1]["afterSha256"] = json!("c".repeat(64));
    assert!(super::recovery::normalize_entries(&conflict).is_err());
}

#[test]
fn actual_bun_recovery_path_boundaries_match() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../bun-golden.json")).unwrap();
    for case in fixture["recoveryPaths"].as_array().unwrap() {
        let path = case["path"].as_str().unwrap();
        let entry = json!({"path":path,"startLine":1,"beforeSha256":"a".repeat(64),"afterSha256":"b".repeat(64)});
        let actual = super::recovery::normalize_entries(&json!([entry.clone(), entry]));
        if let Some(expected) = case["normalized"].as_str() {
            assert_eq!(actual.unwrap()[0].path, expected, "path={path:?}");
        } else {
            assert_eq!(
                actual.unwrap_err().message(),
                case["error"].as_str().unwrap(),
                "path={path:?}"
            );
        }
    }
}
