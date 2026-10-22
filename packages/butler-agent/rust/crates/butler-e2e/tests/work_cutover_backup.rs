//! Scoped snapshot contracts replace the former all-pages copy contracts.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test assertions")]
use butler_work::{
    cutover::{self, CutoverState, Inventory},
    work_schema,
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
};

fn fixture() -> PathBuf {
    let root = std::env::temp_dir().join(format!("scoped-backup-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("agent-runtime")).unwrap();
    let db = Connection::open(root.join("agent-runtime/btcc.sqlite")).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL").unwrap();
    db.execute_batch(include_str!("../fixtures/work-model-cutover/schema.sql"))
        .unwrap();
    work_schema::ensure(&db).unwrap();
    db.execute_batch(include_str!("../fixtures/work-model-cutover/btcc.sql"))
        .unwrap();
    db.execute(
        "UPDATE btcc_guided_works SET objective=?1 WHERE work_id='legacy-open'",
        ["정원 계획 🌱"],
    )
    .unwrap();
    db.execute_batch("DELETE FROM agent_task_graph_changes; INSERT INTO agent_task_graph_changes VALUES(10,'legacy-session')").unwrap();
    root
}
fn inventory() -> Inventory {
    let mut inventory = Inventory::default();
    for (table, keys) in [
        ("btcc_guided_works", vec!["legacy-open", "new-work"]),
        ("btcc_guided_turn_work_bindings", vec!["new-binding"]),
        ("btcc_guided_work_results", vec!["new-result"]),
        (
            "btcc_guided_work_session_heads",
            vec!["legacy-session", "new-session"],
        ),
        (
            "agent_task_graph_changes",
            vec!["legacy-session", "new-session"],
        ),
    ] {
        inventory
            .keys
            .insert(table.into(), keys.into_iter().map(str::to_owned).collect());
    }
    inventory
        .observations
        .push(json!({"work_id":"legacy-open","objective":"original"}));
    inventory
}
fn sets(root: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(root.join("backups/work-model-cutover"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect()
}
fn preimage(db: &Connection, table: &str, key: &str) -> Option<Value> {
    let raw: Option<String> = db
        .query_row(
            "SELECT row_json FROM preimages WHERE table_name=?1 AND key=?2",
            [table, key],
            |r| r.get(0),
        )
        .unwrap();
    raw.map(|raw| serde_json::from_str(&raw).unwrap())
}

// test-category: pure-logic
#[test]
fn inventory_hash_binds_retries_and_partial_cleanup() -> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    assert!(!cutover::has_space(99, 100));
    assert!(cutover::has_space(100, 100));
    let root = fixture();
    let mut inventory = inventory();
    let hash = inventory.hash()?;
    assert_eq!(hash, inventory.clone().hash()?);
    let partial = root.join("backups/work-model-cutover/20000101T000000.000000000Z");
    std::fs::create_dir_all(&partial)?;
    std::fs::write(partial.join("pre-cutover.sqlite"), b"partial")?;
    assert!(cutover::frozen_inventory(&root)?.is_none());
    assert_eq!(
        cutover::prepare(&root, &inventory)?,
        CutoverState::Importing
    );
    assert!(!partial.exists());
    let before = sets(&root);
    assert_eq!(before.len(), 1);
    assert!(cutover::valid(&before[0])?);
    assert_eq!(cutover::frozen_inventory(&root)?.unwrap().hash()?, hash);
    assert_eq!(
        cutover::prepare(&root, &inventory)?,
        CutoverState::Importing
    );
    assert_eq!(sets(&root), before);
    inventory.observations[0]["objective"] = json!("changed Ledger Work");
    assert_ne!(inventory.hash()?, hash);
    assert_eq!(
        cutover::prepare(&root, &inventory)?,
        CutoverState::Importing
    );
    let after = sets(&root);
    assert_eq!(after.len(), 1);
    assert_ne!(after, before);
    assert!(!before[0].exists());
    assert_eq!(
        cutover::frozen_inventory(&root)?.unwrap().hash()?,
        inventory.hash()?
    );
    let db = Connection::open(root.join("agent-runtime/btcc.sqlite"))?;
    db.execute_batch(
        "UPDATE btcc_guided_works SET objective=CAST(X'80' AS TEXT) WHERE work_id='legacy-open'",
    )?;
    inventory.observations[0]["objective"] = json!("another revision");
    assert!(cutover::prepare(&root, &inventory).is_err());
    assert_eq!(sets(&root), after);
    assert!(cutover::valid(&after[0])?);
    drop(db);
    std::fs::remove_dir_all(root)?;
    Ok(())
}

// test-category: race
#[test]
fn scoped_snapshot_captures_absence_and_restores_coalesced_feed()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let root = fixture();
    let inventory = inventory();
    let (request, requests) = mpsc::channel();
    let (commit, committed) = mpsc::channel();
    let writer_root = root.clone();
    let writer = std::thread::spawn(move || {
        requests.recv().unwrap();
        let db = Connection::open(writer_root.join("agent-runtime/btcc.sqlite")).unwrap();
        db.execute_batch("BEGIN; INSERT INTO btcc_guided_works SELECT * FROM btcc_guided_works WHERE work_id='legacy-open' ON CONFLICT(work_id) DO UPDATE SET objective='concurrent change'; INSERT INTO btcc_guided_work_session_heads VALUES('new-session','new-work','now'); COMMIT").unwrap();
        commit.send(()).unwrap();
    });
    let wrote = AtomicBool::new(false);
    let result = cutover::prepare_with_cancel(&root, &inventory, &|| {
        let exporting = root.join("backups/work-model-cutover").is_dir()
            && sets(&root)
                .iter()
                .any(|s| s.join("pre-cutover.sqlite").exists());
        if exporting && !wrote.swap(true, Ordering::SeqCst) {
            request.send(()).unwrap();
            committed.recv().unwrap();
        }
        false
    });
    // Always release/join our writer, including an early export failure.
    if !wrote.load(Ordering::SeqCst) {
        request.send(()).unwrap();
    }
    writer.join().unwrap();
    assert_eq!(result?, CutoverState::Importing);
    let sets = sets(&root);
    assert_eq!(sets.len(), 1);
    assert!(cutover::valid(&sets[0])?);
    let side = Connection::open(sets[0].join("pre-cutover.sqlite"))?;
    assert_ne!(
        preimage(&side, "btcc_guided_works", "legacy-open").unwrap()["objective"],
        "concurrent change"
    );
    assert!(preimage(&side, "btcc_guided_works", "new-work").is_none());
    assert!(preimage(&side, "btcc_guided_work_session_heads", "new-session").is_none());
    assert!(preimage(&side, "agent_task_graph_changes", "new-session").is_none());
    let feed = preimage(&side, "agent_task_graph_changes", "legacy-session").unwrap();
    assert_eq!(feed, json!({"seq":10,"session_id":"legacy-session"}));
    let db = Connection::open(root.join("agent-runtime/btcc.sqlite"))?;
    let changed: i64 = db.query_row(
        "SELECT seq FROM agent_task_graph_changes WHERE session_id='legacy-session'",
        [],
        |r| r.get(0),
    )?;
    assert!(changed > 10);
    db.execute("INSERT INTO agent_task_graph_changes(seq,session_id) VALUES(?1,?2) ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq", rusqlite::params![feed["seq"].as_i64(),feed["session_id"].as_str()])?;
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT seq FROM agent_task_graph_changes WHERE session_id='legacy-session'",
            [],
            |r| r.get(0)
        )?,
        10
    );
    let manifest: cutover::Manifest =
        serde_json::from_slice(&std::fs::read(sets[0].join("manifest.json"))?)?;
    assert_eq!(manifest.inventory_hash, inventory.hash()?);
    assert_eq!(manifest.tables["btcc_guided_works"].keys, 2);
    assert_eq!(manifest.tables["btcc_guided_works"].rows, 1);
    assert_eq!(manifest.tables["btcc_guided_works"].absent, 1);
    let raw: String = side.query_row(
        "SELECT row_json FROM preimages WHERE table_name='btcc_guided_works' AND key='legacy-open'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(manifest.tables["btcc_guided_works"].bytes, raw.len() as u64);
    assert_eq!(
        manifest.files[0].size,
        std::fs::metadata(sets[0].join("pre-cutover.sqlite"))?.len()
    );
    assert_eq!(std::fs::read_dir(&sets[0])?.count(), 2);
    assert!(manifest.read_only_tables.contains(&"btcc_turns".into()));
    drop(side);
    drop(db);
    std::fs::remove_dir_all(root)?;
    Ok(())
}
