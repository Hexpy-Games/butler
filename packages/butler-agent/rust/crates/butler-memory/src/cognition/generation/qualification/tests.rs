use std::fs;

use serde_json::json;

use super::{source::EvidenceInventory, validate_evidence};

pub(crate) fn memory_inventory_hash_matches_source_ecmascript_projection() {
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
        serde_json::from_str::<EvidenceInventory>(&inventory.to_string())
            .unwrap()
            .hash()
            .unwrap(),
        "f476671143536ff9272e0a756593a9da40e89532328016b3f51ce5e0e690715e"
    );
}

/// Inventories with populated, missing, `null` and odd-shaped fields hash as
/// the pre-typing `Value` projection did (hashes generated from merge-base
/// e1d5f72b1 into `fixtures/inventory-hash.json`).
#[test]
fn memory_inventory_hash_matches_pre_typing_hashes() {
    let cases: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("fixtures/inventory-hash.json")).unwrap();
    assert!(cases.len() >= 5);
    for case in cases {
        let inventory =
            serde_json::from_str::<EvidenceInventory>(&case["inventory"].to_string()).unwrap();
        assert_eq!(
            inventory.hash().unwrap(),
            case["hash"].as_str().unwrap(),
            "{}",
            case["inventory"]
        );
    }
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
    assert_eq!(error.code(), "memory_acceptance_version_mismatch");
}
