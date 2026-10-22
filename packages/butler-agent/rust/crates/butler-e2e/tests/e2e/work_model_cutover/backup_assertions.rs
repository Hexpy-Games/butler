use butler_e2e::e2e::HarnessError;
use butler_work::cutover::{Inventory, Manifest};
use rusqlite::{Connection, types::ValueRef};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

type Snapshot = BTreeMap<String, Vec<(String, String)>>;

pub(super) fn snapshot(root: &Path) -> Result<Snapshot, HarnessError> {
    let db = Connection::open(root.join("agent-runtime/btcc.sqlite"))?;
    let tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND (name GLOB 'btcc_guided_*' OR name GLOB 'btcc_subsession_*' OR name IN ('btcc_turns','btcc_session_relations','btcc_steward_results','agent_task_graph_changes')) ORDER BY name")?
        .query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut result = BTreeMap::new();
    for table in tables {
        let mut stmt = db.prepare(&format!("SELECT * FROM \"{table}\""))?;
        let key = if table == "agent_task_graph_changes" {
            "session_id"
        } else {
            stmt.column_names()[0]
        };
        let key_index = stmt.column_index(key)?;
        let count = stmt.column_count();
        let rows = stmt
            .query_map([], |row| {
                let key = format!("{:?}", row.get_ref(key_index)?);
                let contents = (0..count)
                    .map(|i| row.get_ref(i).map(|v| format!("{v:?}")))
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok((key, contents.join("\n")))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        result.insert(table, rows);
    }
    Ok(result)
}
fn hashes(snapshot: Snapshot, inventory: &Inventory) -> BTreeMap<String, String> {
    snapshot
        .into_iter()
        .filter(|(table, _)| table != "agent_task_graph_changes")
        .map(|(table, mut rows)| {
            rows.retain(|(key, _)| {
                !inventory.keys.get(&table).is_some_and(|keys| {
                    keys.iter()
                        .any(|k| format!("{:?}", ValueRef::Text(k.as_bytes())) == *key)
                })
            });
            rows.sort();
            (
                table,
                format!("{:x}", Sha256::digest(serde_json::to_vec(&rows).unwrap())),
            )
        })
        .collect()
}
pub(super) fn bytes(root: &Path) -> u64 {
    [
        "agent-runtime/btcc.sqlite",
        "agent-runtime/btcc.sqlite-wal",
        "app-server/butler-client.sqlite",
        "app-server/butler-client.sqlite-wal",
    ]
    .iter()
    .map(|name| std::fs::metadata(root.join(name)).map_or(0, |m| m.len()))
    .sum()
}
pub(super) fn verify(
    root: &Path,
    before: Snapshot,
    initial_bytes: u64,
) -> Result<(), HarnessError> {
    let sets = std::fs::read_dir(root.join("backups/work-model-cutover"))?
        .map(|e| e.map(|e| e.path()))
        .collect::<Result<Vec<_>, _>>()?;
    assert_eq!(sets.len(), 1);
    let mut names = std::fs::read_dir(&sets[0])?
        .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect::<Result<Vec<_>, _>>()?;
    names.sort();
    assert_eq!(names, ["manifest.json", "pre-cutover.sqlite"]);
    let manifest: Manifest =
        serde_json::from_slice(&std::fs::read(sets[0].join("manifest.json"))?)?;
    let db = Connection::open(sets[0].join("pre-cutover.sqlite"))?;
    let raw: String = db.query_row(
        "SELECT value FROM metadata WHERE key='inventory'",
        [],
        |r| r.get(0),
    )?;
    let inventory: Inventory = serde_json::from_str(&raw)?;
    assert_eq!(manifest.inventory_hash, inventory.hash()?);
    for (table, keys) in &inventory.keys {
        let captured = db
            .prepare("SELECT key FROM preimages WHERE table_name=?1 ORDER BY key")?
            .query_map([table], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(captured, keys.iter().cloned().collect::<Vec<_>>());
    }
    // Native startup registers runtime owners and repairs objectives before the
    // cutover starts. Hash legacy source tables, not process ownership/control
    // tables. Feed UPDATEs always allocate seq > max(seq); the backup snapshot's
    // watermark separately detects every unenumerated cutover feed write.
    let watermark: i64 = db.query_row(
        "SELECT CAST(value AS INTEGER) FROM metadata WHERE key='feed_watermark'",
        [],
        |r| r.get(0),
    )?;
    let feed = Connection::open(root.join("agent-runtime/btcc.sqlite"))?;
    let sessions = feed
        .prepare("SELECT session_id FROM agent_task_graph_changes WHERE seq>?1")?
        .query_map([watermark], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    assert!(sessions.iter().all(|s| {
        inventory
            .keys
            .get("agent_task_graph_changes")
            .is_some_and(|keys| keys.contains(s))
    }));
    let after = snapshot(root)?;
    let outside_feed = |snapshot: &Snapshot| {
        snapshot["agent_task_graph_changes"]
            .iter()
            .map(|(key, _)| key.clone())
            .filter(|key| {
                !inventory
                    .keys
                    .get("agent_task_graph_changes")
                    .is_some_and(|keys| {
                        keys.iter()
                            .any(|k| format!("{:?}", ValueRef::Text(k.as_bytes())) == *key)
                    })
            })
            .collect::<std::collections::BTreeSet<_>>()
    };
    assert_eq!(outside_feed(&before), outside_feed(&after));
    assert_eq!(hashes(before, &inventory), hashes(after, &inventory));
    let live = Connection::open(root.join("agent-runtime/btcc.sqlite"))?;
    let mut counts = BTreeMap::new();
    for table in [
        "btcc_guided_works",
        "btcc_guided_work_plan_revisions",
        "btcc_subsession_directions",
        "wm_works",
        "wm_tasks",
        "wm_task_parts",
        "wm_audit",
        "wm_outbox",
    ] {
        counts.insert(
            table,
            live.query_row::<u64, _, _>(&format!("SELECT count(*) FROM {table}"), [], |r| {
                r.get(0)
            })?,
        );
    }
    measure(root, &live)?;
    eprintln!(
        "WMU-12 scoped bytes: side={}, DB+WAL before={}, after={}, growth={}; inventory keys={:?}; rows={counts:?}",
        manifest.files[0].size,
        initial_bytes,
        bytes(root),
        bytes(root).saturating_sub(initial_bytes),
        inventory
            .keys
            .iter()
            .map(|(k, v)| (k, v.len()))
            .collect::<BTreeMap<_, _>>()
    );
    Ok(())
}

fn measure(root: &Path, db: &Connection) -> Result<(), HarnessError> {
    let wal = std::fs::read(root.join("agent-runtime/btcc.sqlite-wal"))?;
    let page = u32::from_be_bytes(wal[8..12].try_into().unwrap()) as usize;
    let frames = wal[32..].chunks_exact(page + 24).collect::<Vec<_>>();
    let pages = frames
        .iter()
        .map(|f| u32::from_be_bytes(f[..4].try_into().unwrap()))
        .collect::<std::collections::BTreeSet<_>>();
    let records: u64 = db.query_row("SELECT coalesce(sum(payload),0) FROM dbstat WHERE name IN (SELECT name FROM sqlite_schema WHERE tbl_name GLOB 'wm_*')", [], |r| r.get(0))?;
    eprintln!(
        "WMU-12 BTCC WAL frames={}, distinct pages={}, wm record bytes={records}",
        frames.len(),
        pages.len()
    );
    Ok(())
}
