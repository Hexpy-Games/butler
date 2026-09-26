use std::path::{Path, PathBuf};

use serde_json::json;

use super::*;
use crate::cognition::CognitionPathEnvironment;

const ACTIVE: &str = "11111111-1111-1111-1111-111111111111";
const REBUILD: &str = "22222222-2222-2222-2222-222222222222";

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "butler-cognition-generation-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(path.join("memory/generations")).unwrap();
        Self(path)
    }

    fn environment(&self) -> CognitionPathEnvironment {
        CognitionPathEnvironment {
            cognition_home: None,
            memory_home: Some(self.0.join("memory").to_string_lossy().into_owned()),
        }
    }

    fn descriptor(&self, generation: &str, mode: &str) {
        std::fs::write(
            self.0.join("memory/active-generation.json"),
            json!({
                "schema":"butler.memory-active-generation.v2",
                "generation_id":generation,
                "projection_mode":mode
            })
            .to_string(),
        )
        .unwrap();
    }

    fn manifest(&self, generation: &str, value: &serde_json::Value) {
        let root = self.0.join("memory/generations").join(generation);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("manifest.json"), value.to_string()).unwrap();
        std::fs::write(root.join("graph.sqlite"), []).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn manifest(generation: &str, state: &str, snapshot: Option<(&str, &str)>) -> serde_json::Value {
    let mut value = json!({
        "schema":"butler.memory-generation.v2",
        "generation_id":generation,
        "format":"v2",
        "state":state,
        "embedding":null
    });
    if let Some((id, path)) = snapshot {
        value["canonical_snapshot_id"] = id.into();
        value["canonical_snapshot_path"] = path.into();
    }
    value
}

#[test]
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

#[test]
fn active_and_rebuild_resolution_keep_source_roots_and_refresh_authority() {
    let fixture = Fixture::new();
    fixture.descriptor(ACTIVE, "running");
    fixture.manifest(ACTIVE, &manifest(ACTIVE, "active", None));
    fixture.manifest(
        REBUILD,
        &manifest(
            REBUILD,
            "building",
            Some((
                "snapshot",
                "source-snapshot/runtime/conversation-store.sqlite",
            )),
        ),
    );
    let environment = fixture.environment();
    let active_target = MemoryGenerationTarget::Active {
        expected_generation: ACTIVE.into(),
    };
    let active = resolve_generation(Path::new("ignored"), &environment, &active_target).unwrap();
    assert_eq!(active.source_root, Path::new("ignored"));
    assert_mutation_authority(Path::new("ignored"), &environment, &active_target, &active).unwrap();

    let rebuild_target = MemoryGenerationTarget::Rebuild {
        generation_id: REBUILD.into(),
        canonical_snapshot_id: "snapshot".into(),
    };
    let rebuild = resolve_generation(Path::new("ignored"), &environment, &rebuild_target).unwrap();
    assert_eq!(
        rebuild.source_root,
        fixture
            .0
            .join("memory/generations")
            .join(REBUILD)
            .join("source-snapshot")
    );
    assert_mutation_authority(
        Path::new("ignored"),
        &environment,
        &rebuild_target,
        &rebuild,
    )
    .unwrap();

    fixture.descriptor(REBUILD, "running");
    assert_eq!(
        assert_mutation_authority(
            Path::new("ignored"),
            &environment,
            &rebuild_target,
            &rebuild,
        )
        .unwrap_err()
        .code,
        "memory_generation_changed"
    );
}

#[test]
fn active_read_resolves_only_the_current_descriptor_and_manifest() {
    let fixture = Fixture::new();
    fixture.descriptor(ACTIVE, "running");
    fixture.manifest(ACTIVE, &manifest(ACTIVE, "active", None));
    fixture.manifest(REBUILD, &manifest(REBUILD, "building", None));
    let environment = fixture.environment();
    let current = resolve_active_generation(Path::new("canonical"), &environment).unwrap();
    assert_eq!(current.generation_id, ACTIVE);
    assert_eq!(current.source_root, Path::new("canonical"));
    assert_eq!(
        current.graph_path,
        fixture
            .0
            .join("memory/generations")
            .join(ACTIVE)
            .join("graph.sqlite")
    );

    fixture.descriptor(REBUILD, "running");
    let changed = resolve_active_generation(Path::new("canonical"), &environment).unwrap();
    assert_eq!(changed.generation_id, REBUILD);
    assert_eq!(
        changed.graph_path,
        fixture
            .0
            .join("memory/generations")
            .join(REBUILD)
            .join("graph.sqlite")
    );

    std::fs::remove_file(
        fixture
            .0
            .join("memory/generations")
            .join(REBUILD)
            .join("manifest.json"),
    )
    .unwrap();
    assert_eq!(
        resolve_active_generation(Path::new("canonical"), &environment)
            .unwrap_err()
            .code,
        "memory_generation_unavailable"
    );
}

#[test]
fn malformed_descriptor_and_loose_generation_id_keep_source_errors() {
    let fixture = Fixture::new();
    fixture.descriptor("ABC", "running");
    let environment = fixture.environment();
    let target = MemoryGenerationTarget::Active {
        expected_generation: "ABC".into(),
    };
    assert_eq!(
        resolve_generation(Path::new("ignored"), &environment, &target)
            .unwrap_err()
            .code,
        "memory_generation_version_unsupported"
    );
}
