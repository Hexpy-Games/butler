//! Deterministic owner-scale aliases: 14,293 nodes, 16,561 aliases, 886,340 grams.
use rusqlite::{Connection, params};
use std::{collections::BTreeSet, path::Path};

pub(super) fn legacy(path: &Path) {
    let mut db = Connection::open(path).unwrap();
    db.pragma_update(None, "cache_size", -32768).unwrap();
    db.pragma_update(None, "synchronous", "NORMAL").unwrap();
    db.execute_batch("DROP VIEW memory_alias_postings; DROP TRIGGER memory_alias_documents_update; DROP TRIGGER memory_alias_index_insert; DROP TRIGGER memory_alias_index_update; DROP TRIGGER memory_alias_index_delete; DROP TABLE memory_alias_grams; DROP TABLE memory_alias_documents; DELETE FROM memory_state WHERE key='alias_postings_v2'").unwrap();
    db.execute_batch(include_str!("../../fixtures/F-memory-empty/alias-v1.sql"))
        .unwrap();
    db.execute(
        "INSERT INTO memory_state VALUES('alias_postings_incremental_v1','complete')",
        [],
    )
    .unwrap();
    let tx = db.transaction().unwrap();
    let mut rng = 435u64;
    let alphabet: Vec<char> =
        "abcdefghijklmnopqrstuvwxyz가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허"
            .chars()
            .collect();
    for i in 0usize..14293 {
        let node = format!("{i:036}");
        tx.execute("INSERT INTO memory_nodes(id,type,label_original,identity_scope,created_at) VALUES(?1,?2,'synthetic','global','2026-01-01')", params![node,if i.is_multiple_of(5) {"preference"} else {"entity"}]).unwrap();
        if i.is_multiple_of(5) {
            tx.execute("INSERT INTO memory_claims(node_id,statement,speech_act,basis,polarity,valid_from,valid_to,salience,source_class) VALUES(?1,'synthetic','assert','user_statement','positive','2026-01-01',?2,'normal','user')",params![node,if i.is_multiple_of(7) {Some("2026-09-01")}else{None}]).unwrap();
        }
    }
    let mut postings = 0;
    for i in 0..16561 {
        let target = if i < 8607 { 54 } else { 53 };
        let (surface, grams) = loop {
            let motif: String = (0..27)
                .map(|_| {
                    rng ^= rng << 13;
                    rng ^= rng >> 7;
                    rng ^= rng << 17;
                    alphabet[usize::try_from(rng % u64::try_from(alphabet.len()).unwrap()).unwrap()]
                })
                .collect();
            let text: String = motif.chars().cycle().take(83).collect();
            let grams = grams(&text);
            if grams.len() == target {
                break (text, grams);
            }
        };
        seed_alias(&tx, i, &surface, &grams);
        postings += grams.len();
    }
    assert_eq!(postings, 886_340);
    tx.execute("DELETE FROM memory_alias_index_dirty", [])
        .unwrap();
    tx.commit().unwrap();
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
}

fn seed_alias(db: &Connection, i: usize, surface: &str, grams: &BTreeSet<String>) {
    let node = format!("{:036}", i % 14293);
    let source = format!("{i:064x}");
    let episode = format!("episode-{i}");
    let project = if i.is_multiple_of(3) {
        Some(format!("project-{}", i % 4))
    } else {
        None
    };
    db.execute("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,project_id,origin_kind,status,source_hash,created_at,updated_at) VALUES(?1,?1,'1',?2,?3,'user_input',?4,?5,'2026-01-01','2026-01-01')",params![episode,format!("session-{}",i%8),project,if i.is_multiple_of(11){"inactive"}else{"active"},source]).unwrap();
    db.execute("INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES(?1,?2,?3,'conversation','text','/text',0,83,?1,'user',?4,?5,'user_statement')",params![source,episode,if i.is_multiple_of(17){"0"}else{"1"},if i.is_multiple_of(13){"internal_control"}else{"user_input"},if i.is_multiple_of(19){"2026-11-01"}else{"2026-01-01"}]).unwrap();
    db.execute("INSERT INTO memory_aliases(node_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES(?1,?2,?2,?2,?3,'literal')",params![node,surface,source]).unwrap();
    let mut insert = db
        .prepare_cached("INSERT INTO memory_alias_postings VALUES(?1,?2,?3,?4,'global',NULL)")
        .unwrap();
    for gram in grams {
        insert
            .execute(params![gram, node, source, surface])
            .unwrap();
    }
}

pub(super) fn grams(text: &str) -> BTreeSet<String> {
    let chars: Vec<_> = text.chars().collect();
    [2, 3]
        .into_iter()
        .flat_map(|n| chars.windows(n).map(|c| c.iter().collect()))
        .collect()
}

// SQLite's built-in busy timeout backs off to 100ms, which can miss every
// 10ms lease-release gap. Probe the real gaps within the same two-second bound.
thread_local! {
    static GATE_DEADLINE: std::cell::Cell<Option<std::time::Instant>> = const { std::cell::Cell::new(None) };
}

pub(super) fn hold_gate(db: &Connection) {
    let started = std::time::Instant::now();
    let budget = std::time::Duration::from_secs(2);
    GATE_DEADLINE.with(|deadline| deadline.set(Some(started + budget)));
    db.busy_handler(Some(gate_busy)).unwrap();
    let held = db.execute_batch("BEGIN IMMEDIATE");
    db.busy_handler(None).unwrap();
    GATE_DEADLINE.with(|deadline| deadline.set(None));
    held.unwrap();
    butler_e2e::assert_wall_clock_budget!(
        started.elapsed(),
        budget,
        "alias kill-point gate acquisition"
    );
}

fn gate_busy(_: i32) -> bool {
    let remaining = GATE_DEADLINE.with(|deadline| {
        deadline
            .get()
            .map(|at| at.saturating_duration_since(std::time::Instant::now()))
    });
    match remaining {
        Some(remaining) if !remaining.is_zero() => {
            std::thread::sleep(remaining.min(std::time::Duration::from_millis(1)));
            true
        }
        _ => false,
    }
}
