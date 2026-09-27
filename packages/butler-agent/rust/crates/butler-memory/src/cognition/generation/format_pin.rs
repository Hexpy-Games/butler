//! Byte-level format pin for every generation file and command result.
//!
//! The goldens in `fixtures/format/` were generated from the pre-typing
//! `serde_json::Value` writers. Run with `BUTLER_BLESS_FORMAT=1` to regenerate
//! them only when a format change is intended.

use std::{
    cmp::Ordering,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use butler_turn::conversation::{
    AgentConversationStore, ConversationIdentityClock, ConversationLocaleCollation,
    ConversationStoreConfig,
};
use tokio_util::sync::CancellationToken;

use crate::cognition::CognitionPathEnvironment;
use crate::coordination::{
    CognitionCoordinationHost, CognitionProcessStatus, CognitionWriteCoordinator,
};

const NOW: &str = "2026-09-23T00:00:00.000Z";

struct Host;

impl ConversationIdentityClock for Host {
    fn id(&self, prefix: &'static str) -> String {
        format!("{prefix}_{}", uuid::Uuid::new_v4())
    }

    fn now_iso(&self) -> String {
        NOW.into()
    }
}

impl ConversationLocaleCollation for Host {
    fn compare(&self, left: &str, right: &str) -> Ordering {
        left.cmp(right)
    }
}

impl CognitionCoordinationHost for Host {
    fn process_id(&self) -> u32 {
        std::process::id()
    }

    fn hostname(&self) -> crate::coordination::CoordinationResult<String> {
        Ok("format-pin".into())
    }

    fn process_status(&self, pid: u64) -> CognitionProcessStatus {
        if pid == u64::from(std::process::id()) {
            CognitionProcessStatus::Alive
        } else {
            CognitionProcessStatus::Uncertain
        }
    }

    fn new_uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }

    fn now_epoch_millis(&self) -> i64 {
        i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        )
        .unwrap_or(i64::MAX)
    }

    fn now_iso(&self) -> String {
        NOW.into()
    }
}

struct Root(PathBuf);

impl Root {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "butler-generation-format-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Replaces run-specific identifiers so the remaining bytes are comparable.
struct Normalizer(Vec<(String, String)>);

impl Normalizer {
    fn apply(&self, text: &str) -> String {
        let mut text = text.to_owned();
        for (from, to) in &self.0 {
            text = text.replace(from, to);
        }
        regex::Regex::new(r#""duration_ms":\d+"#)
            .unwrap()
            .replace_all(&text, r#""duration_ms":0"#)
            .into_owned()
    }
}

fn pin(name: &str, actual: &str) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/cognition/generation/fixtures/format")
        .join(name);
    if std::env::var_os("BUTLER_BLESS_FORMAT").is_some() {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, actual).unwrap();
        return;
    }
    let expected = fs::read_to_string(&path).unwrap_or_else(|_| panic!("missing golden {name}"));
    assert_eq!(actual, expected, "format of {name} changed");
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

async fn conversation_store(root: &Path) {
    let host = Arc::new(Host);
    let store = AgentConversationStore::open(ConversationStoreConfig {
        path: root.join("runtime/conversation-store.sqlite"),
        identity_clock: host.clone(),
        collation: host,
    })
    .await
    .unwrap();
    store.close().await.unwrap();
}

type Coordinator = Arc<CognitionWriteCoordinator>;

#[tokio::test]
async fn generation_files_and_results_keep_their_pre_typing_bytes() {
    let coordinator = Arc::new(CognitionWriteCoordinator::new(Arc::new(Host)).unwrap());
    let environment = CognitionPathEnvironment::default();
    pin_empty_generation(&coordinator, &environment).await;
    let data = Root::new();
    let rebuild = pin_prepared_rebuild(&data.0, &coordinator, &environment).await;
    let (readiness, recorded_text) =
        pin_readiness(&data.0, &coordinator, &environment, &rebuild).await;
    pin_qualification_and_activation(&data.0, &rebuild, &readiness, &recorded_text);
}

/// Empty initialization: manifest and descriptor.
async fn pin_empty_generation(coordinator: &Coordinator, environment: &CognitionPathEnvironment) {
    let empty = Root::new();
    let handle = super::initialize_empty_memory_generation(
        empty.0.clone(),
        environment.clone(),
        coordinator.clone(),
        Arc::new(|| NOW.to_owned()),
        "17.0.0".into(),
        "ICU4X 1.4.0".into(),
    )
    .await
    .unwrap();
    let memory = environment.memory_root(&empty.0);
    let normalize = Normalizer(vec![(handle.generation_id.clone(), "<EMPTY>".into())]);
    pin(
        "empty-manifest.json",
        &normalize.apply(&read(&handle.root.join("manifest.json"))),
    );
    pin(
        "empty-descriptor.json",
        &normalize.apply(&read(&memory.join("active-generation.json"))),
    );
}

/// A prepared rebuild next to its legacy baseline.
struct Rebuild {
    prepared: super::rebuild::PreparedRebuild,
    legacy_id: String,
    root: PathBuf,
    normalize: Normalizer,
}

/// Legacy baseline and rebuild preparation.
async fn pin_prepared_rebuild(
    data: &Path,
    coordinator: &Coordinator,
    environment: &CognitionPathEnvironment,
) -> Rebuild {
    conversation_store(data).await;
    let prepared = super::prepare_memory_rebuild(
        data.to_path_buf(),
        environment.clone(),
        coordinator.clone(),
        CancellationToken::new(),
        NOW.into(),
        "17.0.0".into(),
        "ICU4X 1.4.0".into(),
    )
    .await
    .unwrap();
    let memory = environment.memory_root(data);
    let descriptor_text = read(&memory.join("active-generation.json"));
    let descriptor: serde_json::Value = serde_json::from_str(&descriptor_text).unwrap();
    let legacy_id = descriptor["generation_id"].as_str().unwrap().to_owned();
    let legacy_root = memory.join("generations").join(&legacy_id);
    let legacy: serde_json::Value =
        serde_json::from_str(&read(&legacy_root.join("manifest.json"))).unwrap();
    let root = memory.join("generations").join(&prepared.generation_id);
    let normalize = Normalizer(vec![
        (legacy_id.clone(), "<LEGACY>".into()),
        (
            legacy["canonical_snapshot_id"].as_str().unwrap().to_owned(),
            "<LEGACY_SNAPSHOT>".into(),
        ),
        (prepared.generation_id.clone(), "<REBUILD>".into()),
        (prepared.canonical_snapshot_id.clone(), "<SNAPSHOT>".into()),
    ]);
    pin(
        "legacy-manifest.json",
        &normalize.apply(&read(&legacy_root.join("manifest.json"))),
    );
    pin("legacy-descriptor.json", &normalize.apply(&descriptor_text));
    pin(
        "prepared-manifest.json",
        &normalize.apply(&read(&root.join("manifest.json"))),
    );
    pin(
        "prepared-inventory.json",
        &normalize.apply(&read(
            &root.join("source-snapshot/memory-source-inventory.json"),
        )),
    );
    Rebuild {
        prepared,
        legacy_id,
        root,
        normalize,
    }
}

/// Readiness record and inspection; the readiness and the recorded manifest.
async fn pin_readiness(
    data: &Path,
    coordinator: &Coordinator,
    environment: &CognitionPathEnvironment,
    rebuild: &Rebuild,
) -> (super::GenerationReadiness, String) {
    let Rebuild {
        prepared,
        normalize,
        ..
    } = rebuild;
    let target = super::MemoryGenerationTarget::Rebuild {
        generation_id: prepared.generation_id.clone(),
        canonical_snapshot_id: prepared.canonical_snapshot_id.clone(),
    };
    let readiness = super::record_rebuild_readiness(
        data,
        environment,
        coordinator.clone(),
        &target,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    pin(
        "readiness-result.json",
        &normalize.apply(&serde_json::to_string(&readiness).unwrap()),
    );
    let recorded_text = read(&rebuild.root.join("manifest.json"));
    pin("readiness-manifest.json", &normalize.apply(&recorded_text));
    let inspected =
        super::inspect_memory_rebuild(data, environment, &prepared.generation_id).unwrap();
    let inspected = serde_json::to_string(&inspected)
        .unwrap()
        .replace(&data.to_string_lossy().into_owned(), "<DATA>");
    pin("inspect-result.json", &normalize.apply(&inspected));
    (readiness, recorded_text)
}

/// Qualification and activation writers.
fn pin_qualification_and_activation(
    data: &Path,
    rebuild: &Rebuild,
    readiness: &super::GenerationReadiness,
    recorded_text: &str,
) {
    let Rebuild {
        prepared,
        legacy_id,
        normalize,
        ..
    } = rebuild;
    let mut qualified: super::GenerationManifest = serde_json::from_str(recorded_text).unwrap();
    super::qualification_service::qualify_manifest(
        &mut qualified,
        readiness,
        &super::qualification::ValidatedEvidence {
            acceptance_sha256: "a".repeat(64),
            verification_generation_id: "33333333-3333-3333-3333-333333333333".into(),
            implementation_commit: "b".repeat(40),
            files: Vec::new(),
        },
        &prepared.generation_id,
        &prepared.source_inventory_hash,
    );
    let qualified_path = data.join("qualified.json");
    super::initialize::durable::write_json(&qualified_path, &qualified).unwrap();
    pin(
        "qualified-manifest.json",
        &normalize.apply(&read(&qualified_path)),
    );
    let next = super::cutover::next_descriptor_for_pin(
        &prepared.generation_id,
        legacy_id,
        NOW,
        super::ProjectionMode::Running,
    );
    let next_path = data.join("next-descriptor.json");
    super::initialize::durable::write_json(&next_path, &next).unwrap();
    pin(
        "activated-descriptor.json",
        &normalize.apply(&read(&next_path)),
    );
}
