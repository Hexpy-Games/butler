use std::fs;

use serde_json::json;

use super::{
    io::{safe_ref, valid_git_commit, valid_sha},
    source::memory_inventory_hash,
    validate_evidence,
};

#[test]
fn memory_inventory_hash_matches_source_ecmascript_projection() {
    let inventory = json!({
        "schema": "s",
        "origin": { "version": null },
        "exclusions": {},
        "entries": [],
        "typed": [],
        "typed_lifecycle": [],
        "history": []
    });
    assert_eq!(
        memory_inventory_hash(&inventory).unwrap(),
        "f476671143536ff9272e0a756593a9da40e89532328016b3f51ce5e0e690715e"
    );
}

#[test]
fn acceptance_without_its_own_implementation_revision_is_rejected_without_git_lookup() {
    let root =
        std::env::temp_dir().join(format!("butler-qualification-v3-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let acceptance_path = root.join("acceptance.json");
    fs::write(
        &acceptance_path,
        serde_json::to_vec(&json!({
            "schema": "butler.memory-recovery-acceptance.v3",
            "verification_generation_id": "generation",
            "verification_source_inventory_hash": "a".repeat(64),
            "implementation_commit": "",
            "tool_contract_version": 2,
            "extraction_version": "memory-extract-v3",
            "embedding_version": "b".repeat(64),
            "cases": [],
            "performance": {
                "prepared_graph_p95_ms": 1,
                "prepared_hybrid_p95_ms": 1,
                "graph_samples": 60,
                "hybrid_samples": 60,
                "report_ref": "report.json",
                "report_sha256": "c".repeat(64)
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let error = validate_evidence(
        &acceptance_path,
        root.as_path(),
        None,
        "memory-extract-v3",
        &"b".repeat(64),
    )
    .unwrap_err();
    let _ = fs::remove_dir_all(root);
    assert_eq!(error.code, "memory_acceptance_version_mismatch");
}

#[test]
fn references_and_versions_reject_path_escape_and_noncanonical_hashes() {
    assert!(safe_ref("case/trace.json"));
    assert!(!safe_ref("../trace.json"));
    assert!(!safe_ref("case\\..\\trace.json"));
    assert!(!safe_ref("/absolute/trace.json"));
    assert!(valid_sha(&"a".repeat(64)));
    assert!(!valid_sha(&"A".repeat(64)));
    assert!(valid_git_commit(&"b".repeat(40)));
    assert!(!valid_git_commit(&"b".repeat(39)));
}
