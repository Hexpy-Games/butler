use serde_json::json;

use super::*;

/// Format pin: memory ids, hashes and wire shapes that existing data is read
/// back with. The embedding wire shape written by the JavaScript runtime, the
/// persisted import normalization hashes and ids,
/// window coverage keys and evidence refs, and the work-record writer and
/// reader goldens.
// test-category: format-pin
#[test]
fn persisted_memory_ids_and_hashes_are_stable() {
    existing_javascript_embedding_wire_shape_round_trips_unchanged();
    crate::profile::persisted_import_normalization_hash_and_id_are_stable();
    crate::profile::persisted_window_coverage_key_and_evidence_ref_are_stable();
    crate::work_records::tests::original_writer_and_reader_goldens_preserve_hashes_review_gates_and_read_errors();
}

fn existing_javascript_embedding_wire_shape_round_trips_unchanged() {
    let old = json!({
        "model":"Xenova/bge-m3","dimension":1024,"pooling":"cls","normalize":true,
        "version":"a".repeat(64),"max_tokens":8192,
        "transformers_version":"3.8.1","node_runtime_version":"v22.0.0",
        "bun_runtime_version":null,"tokenizer_asset_sha256":"b".repeat(64),
        "model_asset_sha256":"c".repeat(64)
    });
    let parsed: GenerationEmbedding = serde_json::from_value(old.clone()).unwrap();
    types::validate_generation_embedding(&parsed).unwrap();
    assert!(matches!(parsed, GenerationEmbedding::JavaScript(_)));
    assert_eq!(serde_json::to_value(parsed).unwrap(), old);
}
