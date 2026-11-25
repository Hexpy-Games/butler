//! Upgraded graphs compact alias postings to (gram, alias_id) once, with the
//! same alias rows and frequencies for every gram set; a blocked first attempt
//! leaves the legacy shape whole and the next start completes it.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::memory_fixture;
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Fixture, Setup},
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use std::{
    collections::BTreeSet,
    path::Path,
    time::{Duration, Instant},
};

const CLAIM: &str = "the user decided to water the garden early on weekday mornings because afternoon heat dries the soil, 사용자는 평일 아침 일찍 정원에 물을 주기로 했다";
/// (node, source, surface, folded key): ASCII and precomposed Hangul only, so
/// one char is one grapheme.
const ALIASES: [(&str, &str, &str, &str); 4] = [
    ("n-garden", "src-1", "Garden Watering", "garden watering"),
    ("n-garden", "src-2", "Garden Watering", "garden watering"),
    ("n-korean", "src-1", "정원 물주기 일정", "정원 물주기 일정"),
    ("n-claim", "src-2", CLAIM, CLAIM),
];
const CUES: [&str; 4] = ["garden", "물주기", "weekday 정원", "afternoon heat"];
const OLD_ROWS: &str = "SELECT DISTINCT node_id,source_id,surface_original FROM memory_alias_postings WHERE gram IN (SELECT value FROM json_each(?1)) ORDER BY node_id,source_id,surface_original";
const NEW_ROWS: &str = "SELECT DISTINCT a.node_id,a.source_id,a.surface_original FROM memory_alias_postings p JOIN memory_aliases a ON a.alias_id=p.alias_id WHERE p.gram IN (SELECT value FROM json_each(?1)) ORDER BY a.node_id,a.source_id,a.surface_original";
const OLD_DF: &str = "SELECT gram,COUNT(*) FROM memory_alias_postings WHERE gram IN (SELECT value FROM json_each(?1)) GROUP BY gram ORDER BY gram";
const NEW_DF: &str = "SELECT p.gram,COUNT(*) FROM memory_alias_postings p JOIN memory_aliases a ON a.alias_id=p.alias_id WHERE p.gram IN (SELECT value FROM json_each(?1)) GROUP BY p.gram ORDER BY p.gram";
type Snapshot = Vec<(Vec<(String, String, String)>, Vec<(String, i64)>)>;

fn grams(text: &str) -> BTreeSet<String> {
    let chars = text.chars().collect::<Vec<_>>();
    [2, 3]
        .iter()
        .flat_map(|size| {
            chars
                .windows(*size)
                .map(|window| window.iter().collect::<String>())
        })
        .collect()
}

/// Legacy rows as the old indexer wrote them; returns the posting count.
fn seed(path: &Path) -> i64 {
    let db = Connection::open(path).unwrap();
    db.execute_batch("CREATE INDEX idx_alias_postings_gram_source ON memory_alias_postings(gram,node_id,source_id);
        CREATE INDEX idx_alias_postings_alias ON memory_alias_postings(node_id,source_id,surface_original,gram);
        INSERT INTO memory_nodes(id,type,label_original,identity_scope,created_at) VALUES('n-garden','entity','Garden','user','2026-01-01'),('n-korean','entity','정원','user','2026-01-01'),('n-claim','decision','Watering decision','user','2026-01-01');
        INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,origin_kind,status,source_hash,created_at,updated_at) VALUES('chunk','chunk','1','user_input','active','hash','2026-01-01','2026-01-01');
        INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES('src-1','chunk','1','conversation','part-1','',0,7,'hash','user','user_input','2026-01-01','user_statement'),('src-2','chunk','1','conversation','part-2','',0,7,'hash','user','user_input','2026-01-01','user_statement');").unwrap();
    let mut postings = 0;
    for (node, source, surface, folded) in ALIASES {
        db.execute("INSERT INTO memory_aliases(node_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES(?1,?2,?2,?3,?4,'literal')", params![node, surface, folded, source]).unwrap();
        for gram in grams(folded) {
            db.execute(
                "INSERT INTO memory_alias_postings VALUES(?1,?2,?3,?4,'user',NULL)",
                params![gram, node, source, surface],
            )
            .unwrap();
            postings += 1;
        }
    }
    postings
}

fn snapshot(db: &Connection, rows: &str, df: &str) -> Snapshot {
    CUES.iter()
        .map(|cue| {
            let grams = serde_json::to_string(&grams(cue)).unwrap();
            let matched = db
                .prepare(rows)
                .unwrap()
                .query_map([&grams], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            let frequencies = db
                .prepare(df)
                .unwrap()
                .query_map([&grams], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            (matched, frequencies)
        })
        .collect()
}

fn columns(db: &Connection, table: &str) -> Vec<String> {
    db.prepare(&format!("PRAGMA table_info({table})"))
        .unwrap()
        .query_map([], |r| r.get("name"))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

async fn until_compact(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let state: Option<String> = db
            .query_row(
                "SELECT value FROM memory_state WHERE key='alias_postings_compact_v1'",
                [],
                |r| r.get(0),
            )
            .optional()
            .unwrap();
        if state.as_deref() == Some("complete") {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "alias postings compaction did not finish: {state:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn upgraded_graph_compacts_alias_postings_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("ALIAS-POSTINGS-COMPACT")?.fixture(Fixture::Empty);
    let graph = memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let postings = seed(&graph);
    let db = Connection::open(&graph).unwrap();
    let before = snapshot(&db, OLD_ROWS, OLD_DF);
    assert!(
        before.iter().all(|(rows, _)| !rows.is_empty()),
        "every cue matches before compaction"
    );
    // A competing writer blocks the first attempt; the legacy shape stays whole.
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    let mut s = setup.start().await?;
    tokio::time::sleep(Duration::from_secs(2)).await;
    s.agent.kill9()?;
    db.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        columns(&db, "memory_alias_postings"),
        [
            "gram",
            "node_id",
            "source_id",
            "surface_original",
            "identity_scope",
            "project_id"
        ]
    );
    s.gw = s.agent.start_again().await?;
    until_compact(&graph).await;
    assert_eq!(columns(&db, "memory_alias_postings"), ["gram", "alias_id"]);
    assert_eq!(columns(&db, "memory_aliases")[0], "alias_id");
    let indexes: Vec<String> = db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='memory_alias_postings' AND sql IS NOT NULL ORDER BY name").unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    assert_eq!(indexes, ["idx_alias_postings_alias_id"]);
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM memory_alias_postings", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        postings
    );
    assert_eq!(snapshot(&db, NEW_ROWS, NEW_DF), before);
    s.finish().await
}
