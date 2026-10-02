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

// test-category: format-pin
#[tokio::test]
async fn generation_files_and_results_keep_their_pre_typing_bytes() {
    let coordinator = Arc::new(CognitionWriteCoordinator::new(Arc::new(Host)).unwrap());
    let environment = CognitionPathEnvironment::default();
    pin_empty_generation(&coordinator, &environment).await;
    pin_descriptor_swap_guards(&coordinator, &environment).await;
    let data = Root::new();
    let rebuild = pin_prepared_rebuild(&data.0, &coordinator, &environment).await;
    pin_readiness(&data.0, &coordinator, &environment, &rebuild).await;
    pin_historical_documents();
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
    let prepared_manifest: serde_json::Value =
        serde_json::from_str(&read(&root.join("manifest.json"))).unwrap();
    let snapshot_hash = prepared_manifest["canonical_snapshot"]["file_sha256"]
        .as_str()
        .unwrap();
    assert_eq!(snapshot_hash.len(), 64);
    assert!(snapshot_hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let normalize = Normalizer(vec![
        (legacy_id.clone(), "<LEGACY>".into()),
        (
            legacy["canonical_snapshot_id"].as_str().unwrap().to_owned(),
            "<LEGACY_SNAPSHOT>".into(),
        ),
        (prepared.generation_id.clone(), "<REBUILD>".into()),
        (prepared.canonical_snapshot_id.clone(), "<SNAPSHOT>".into()),
        // The source store now carries a random persistent identity. Its
        // snapshot hash varies per run while the manifest layout stays pinned.
        (snapshot_hash.into(), "<SNAPSHOT_SHA256>".into()),
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

/// The retained offline CAS rejects changed descriptor metadata and manifest bytes.
async fn pin_descriptor_swap_guards(
    coordinator: &Coordinator,
    environment: &CognitionPathEnvironment,
) {
    use super::swap::{
        TransitionGuard, capture_active_descriptor, commit_descriptor_transition, next_descriptor,
    };
    use sha2::{Digest, Sha256};
    let data = Root::new();
    let handle = super::initialize_empty_memory_generation(
        data.0.clone(),
        environment.clone(),
        coordinator.clone(),
        Arc::new(|| NOW.to_owned()),
        "17.0.0".into(),
        "ICU4X 1.4.0".into(),
    )
    .await
    .unwrap();
    let manifest = handle.root.join("manifest.json");
    let bytes = fs::read(&manifest).unwrap();
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let expected = capture_active_descriptor(&data.0, environment).unwrap();
    let next = next_descriptor(
        &handle.generation_id,
        &handle.generation_id,
        NOW,
        super::ProjectionMode::Running,
    );
    let guard = TransitionGuard {
        expected: &expected,
        target_generation_id: &handle.generation_id,
        target_manifest_sha256: &hash,
    };
    let lease = super::stage::acquire(
        coordinator,
        &environment.consolidation_lock(&data.0),
        "cutover",
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let descriptor_path = environment
        .memory_root(&data.0)
        .join("active-generation.json");
    let descriptor_bytes = fs::read(&descriptor_path).unwrap();
    let mut changed: serde_json::Value = serde_json::from_slice(&descriptor_bytes).unwrap();
    changed["unknown"] = serde_json::json!(true);
    fs::write(&descriptor_path, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert_eq!(
        commit_descriptor_transition(&data.0, environment, &lease, &guard, &next)
            .unwrap_err()
            .code(),
        "memory_generation_changed"
    );
    fs::write(&descriptor_path, &descriptor_bytes).unwrap();
    fs::write(&manifest, [bytes.as_slice(), b"\n"].concat()).unwrap();
    assert_eq!(
        commit_descriptor_transition(&data.0, environment, &lease, &guard, &next)
            .unwrap_err()
            .code(),
        "memory_generation_changed"
    );
    fs::write(&manifest, &bytes).unwrap();
    assert_eq!(
        commit_descriptor_transition(&data.0, environment, &lease, &guard, &next)
            .unwrap()
            .fields,
        next
    );
    lease.release(true).unwrap();
}

/// Existing qualified manifests and descriptors remain readable without their writers.
fn pin_historical_documents() {
    for name in ["qualified-manifest.json", "activated-descriptor.json"] {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/cognition/generation/fixtures/format")
            .join(name);
        let original = read(&path);
        let parsed = if name.ends_with("manifest.json") {
            serde_json::to_value(
                serde_json::from_str::<super::GenerationManifest>(&original).unwrap(),
            )
            .unwrap()
        } else {
            serde_json::to_value(
                serde_json::from_str::<super::ActiveDescriptor>(&original).unwrap(),
            )
            .unwrap()
        };
        assert_eq!(
            parsed,
            serde_json::from_str::<serde_json::Value>(&original).unwrap()
        );
    }
}
