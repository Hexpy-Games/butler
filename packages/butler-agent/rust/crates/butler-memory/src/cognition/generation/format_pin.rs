//! Byte-level format pin for every generation file and command result.
//!
//! The goldens in `fixtures/format/` were generated from the pre-typing
//! `serde_json::Value` writers. Run with `BUTLER_BLESS_FORMAT=1` to regenerate
//! them only when a format change is intended.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use tokio_util::sync::CancellationToken;

use crate::cognition::CognitionPathEnvironment;
use crate::coordination::{
    CognitionCoordinationHost, CognitionProcessStatus, CognitionWriteCoordinator,
};

const NOW: &str = "2026-09-23T00:00:00.000Z";

struct Host;

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
        text
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

type Coordinator = Arc<CognitionWriteCoordinator>;

// test-category: format-pin
#[tokio::test]
async fn generation_files_and_results_keep_their_pre_typing_bytes() {
    let coordinator = Arc::new(CognitionWriteCoordinator::new(Arc::new(Host)).unwrap());
    let environment = CognitionPathEnvironment::default();
    pin_empty_generation(&coordinator, &environment).await;
    pin_descriptor_swap_guards(&coordinator, &environment).await;
    pin_historical_documents();
    pin_vacuum_snapshot();
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
    for name in [
        "legacy-manifest.json",
        "prepared-manifest.json",
        "readiness-manifest.json",
        "qualified-manifest.json",
        "legacy-descriptor.json",
        "activated-descriptor.json",
    ] {
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

/// The retained SQLite copy includes committed rows and leaves its source intact.
fn pin_vacuum_snapshot() {
    let data = Root::new();
    let source = data.0.join("source.sqlite");
    let db = rusqlite::Connection::open(&source).unwrap();
    db.execute_batch("CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO records VALUES(1,'one'),(2,'two');").unwrap();
    db.close().unwrap();
    let before = fs::read(&source).unwrap();
    let target = data.0.join("copy/store.sqlite");
    super::swap::vacuum_snapshot(&source, &target).unwrap();
    let copied =
        rusqlite::Connection::open_with_flags(&target, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let rows: Vec<(i64, String)> = copied
        .prepare("SELECT id,value FROM records ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(rows, vec![(1, "one".into()), (2, "two".into())]);
    assert_eq!(fs::read(&source).unwrap(), before);
    assert!(super::swap::vacuum_snapshot(&source, &target).is_err());
    assert_eq!(
        copied
            .query_row("SELECT COUNT(*) FROM records", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
}
