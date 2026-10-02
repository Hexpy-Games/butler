//! Offline acceptance driver. Run only on a disposable copy, never the snapshot.
use butler_memory::{
    cognition::{CognitionPathEnvironment, MemoryRecall},
    coordination::{
        CognitionCoordinationHost, CognitionProcessStatus, CognitionWriteCoordinator,
        CoordinationResult,
    },
    management::MemoryManagement,
};
use butler_turn::conversation::{CanonicalMemoryReadBinding, ConversationSourceReader};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc, time::Instant};
use tokio_util::sync::CancellationToken;

struct Host;
impl CognitionCoordinationHost for Host {
    fn process_id(&self) -> u32 {
        std::process::id()
    }
    fn hostname(&self) -> CoordinationResult<String> {
        Ok("offline-management-probe".into())
    }
    fn process_status(&self, _: u64) -> CognitionProcessStatus {
        CognitionProcessStatus::Uncertain
    }
    fn new_uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn now_epoch_millis(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
    fn now_iso(&self) -> String {
        chrono::Utc::now().to_rfc3339()
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("disposable copy path required")?,
    );
    let paths = CognitionPathEnvironment::default();
    let coordinator = Arc::new(CognitionWriteCoordinator::new(Arc::new(Host))?);
    let owner = MemoryManagement::new(root.clone(), paths.clone(), coordinator);
    let started = Instant::now();
    let inventory = owner
        .refresh(Host.now_iso(), CancellationToken::new())
        .await?;
    println!(
        "{}",
        json!({"inventory":inventory,"measurement_ms":started.elapsed().as_millis()})
    );
    let started = Instant::now();
    let cached = owner.inventory();
    assert_eq!(
        serde_json::to_value(&cached)?,
        serde_json::to_value(&inventory)?
    );
    println!(
        "{}",
        json!({"cached_inventory_us":started.elapsed().as_micros(),"cards":cached.kinds.len()})
    );
    let recall_now = chrono::Utc::now().timestamp_millis();
    let recall = MemoryRecall::new(
        root.clone(),
        paths,
        Arc::new(butler_core::js_date::parse_iso_millis),
        Arc::new(str::cmp),
        Arc::new(move || recall_now),
        1,
    );
    let binding = binding(&root)?;
    let recall_started = Instant::now();
    let before = query(&recall, binding.clone()).await?;
    let recall_before_ms = recall_started.elapsed().as_millis();
    let id = uuid::Uuid::new_v4().to_string();
    let started = Instant::now();
    let result = owner
        .cleanup(
            id,
            inventory.revision,
            CancellationToken::new(),
            Arc::new(|_| {}),
        )
        .await?;
    let cleanup_ms = started.elapsed().as_millis();
    let recall_started = Instant::now();
    let after = query(&recall, binding).await?;
    let recall_after_ms = recall_started.elapsed().as_millis();
    // Volatile request timing fields are excluded, all ranked content/evidence stays equal.
    assert!(before == after, "recall content/order/evidence changed");
    assert!(
        before
            .get("results")
            .and_then(Value::as_array)
            .is_some_and(|v| !v.is_empty()),
        "query must return results"
    );
    println!(
        "{}",
        json!({"cleanup":result,"cleanup_ms":cleanup_ms,"recall_before_ms":recall_before_ms,"recall_after_ms":recall_after_ms,
        "recall_equal":true,"recall_count":before.get("results").and_then(Value::as_array).map(Vec::len)})
    );
    recall.close().await;
    verify_refusal(&root).await?;
    verify_cancellation(&root).await?;
    Ok(())
}

fn binding(
    root: &std::path::Path,
) -> Result<CanonicalMemoryReadBinding, Box<dyn std::error::Error>> {
    let path = root.join("runtime/conversation-store.sqlite");
    let db = butler_platform::sqlite::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let (session, turn, project) = db.query_row(
        "SELECT b.external_session_id,t.id,s.project_id FROM conversation_sessions s JOIN conversation_turns t ON t.session_id=s.id JOIN conversation_bindings b ON b.conversation_session_id=s.id AND b.gateway=s.gateway_origin WHERE s.status='active' AND t.status='complete' AND s.gateway_origin<>'' ORDER BY b.created_at LIMIT 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    drop(db);
    let reader = ConversationSourceReader::open(&path)?;
    reader.close()?;
    Ok(CanonicalMemoryReadBinding {
        runtime_session_id: session,
        turn_id: turn,
        project_id: project,
    })
}

async fn query(
    recall: &MemoryRecall,
    binding: CanonicalMemoryReadBinding,
) -> Result<Value, Box<dyn std::error::Error>> {
    let mut value = recall
        .recall_tool(
            binding,
            "memory".into(),
            "offline-acceptance".into(),
            json!({"cue":"Butler","include_vector":false,"scope":"all_user_sessions","limit":10}),
        )
        .await?;
    if value.get("ok") != Some(&json!(true)) {
        return Err("canonical recall binding unavailable".into());
    }
    if let Some(object) = value.as_object_mut() {
        object.remove("timing");
        object.remove("elapsed_ms");
        if let Some(cursor) = object.get("next_cursor") {
            let more = !cursor.is_null();
            object.insert("next_cursor".into(), json!(more));
        }
    }
    Ok(value)
}

async fn verify_refusal(root: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    let refused = root.join("probe-refused");
    std::fs::create_dir_all(refused.join("app-server"))?;
    std::fs::write(refused.join("app-server/butler-client.sqlite"), b"legacy")?;
    let owner = MemoryManagement::new(
        refused.clone(),
        CognitionPathEnvironment::default(),
        Arc::new(CognitionWriteCoordinator::new(Arc::new(Host))?),
    );
    assert!(
        owner
            .refresh(Host.now_iso(), CancellationToken::new())
            .await
            .is_err()
    );
    assert!(
        owner
            .cleanup(
                uuid::Uuid::new_v4().to_string(),
                0,
                CancellationToken::new(),
                Arc::new(|_| {})
            )
            .await
            .is_err()
    );
    assert_eq!(std::fs::read_dir(&refused)?.count(), 1);
    assert_eq!(
        std::fs::read(refused.join("app-server/butler-client.sqlite"))?,
        b"legacy"
    );
    std::fs::remove_dir_all(refused)?;
    println!("{}", json!({"legacy_refusal":true,"legacy_added_files":0}));
    Ok(())
}

async fn verify_cancellation(root: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    let fixture = root.join("probe-cancellation");
    std::fs::create_dir_all(&fixture)?;
    let paths = CognitionPathEnvironment::default();
    let coordinator = Arc::new(CognitionWriteCoordinator::new(Arc::new(Host))?);
    butler_memory::cognition::initialize_empty_memory_generation(
        fixture.clone(),
        paths.clone(),
        coordinator.clone(),
        Arc::new(|| "2026-10-02T04:01:00.000Z".into()),
        "17.0.0".into(),
        butler_core::locale::LocaleCollation::implementation_version().into(),
    )
    .await?;
    let owner = MemoryManagement::new(fixture.clone(), paths.clone(), coordinator.clone());
    let id = uuid::Uuid::new_v4().to_string();
    let orphan = paths
        .memory_root(&fixture)
        .join("generations")
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&orphan)?;
    let bytes = butler_platform::storage_size::allocated_bytes(&orphan)?.unwrap_or(0);
    let token = CancellationToken::new();
    let cancel = token.clone();
    let revision = coordinator.inventory_revision();
    let failed = owner
        .cleanup(
            id.clone(),
            revision,
            token,
            Arc::new(move |result| {
                if result.phase == "removing" {
                    cancel.cancel();
                }
            }),
        )
        .await;
    assert!(failed.is_err());
    let receipt = owner
        .cleanup_status(id.clone())
        .await?
        .ok_or("missing cancellation receipt")?;
    assert_eq!(receipt.phase, "cancelled");
    let trash = paths
        .memory_root(&fixture)
        .join("management/operations")
        .join(&id)
        .join("trash");
    assert_eq!(std::fs::read_dir(&trash)?.count(), 1);
    drop(owner);
    // A new backend over the same durable disk state: construction must not touch trash.
    let restarted = MemoryManagement::new(fixture.clone(), paths, coordinator);
    assert_eq!(std::fs::read_dir(&trash)?.count(), 1);
    let result = restarted
        .cleanup(
            id.clone(),
            revision,
            CancellationToken::new(),
            Arc::new(|_| {}),
        )
        .await?;
    assert_eq!(result.bytes_reclaimed, bytes);
    assert_eq!(std::fs::read_dir(&trash)?.count(), 0);
    let repeated = restarted
        .cleanup(id, revision, CancellationToken::new(), Arc::new(|_| {}))
        .await?;
    assert_eq!(
        serde_json::to_value(result)?,
        serde_json::to_value(repeated)?
    );
    std::fs::remove_dir_all(fixture)?;
    println!(
        "{}",
        json!({"cancellation_after_rename":true,"explicit_restart_resume":true,
        "synthetic_bytes_reclaimed":bytes,"receipt_idempotency":true})
    );
    Ok(())
}
