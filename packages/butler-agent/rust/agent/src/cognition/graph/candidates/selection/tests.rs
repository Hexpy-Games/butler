use super::*;
use crate::cognition::extraction::ExtractInput;
use crate::cognition::graph::candidates::VectorHit;
use rusqlite::Connection;
use serde_json::{Value, json};

#[test]
fn real_schema_selector_matches_bun_alias_lexical_fusion_golden() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE memory_nodes(id TEXT PRIMARY KEY,type TEXT); \
        CREATE TABLE memory_chunks(memory_chunk_id TEXT PRIMARY KEY,current_revision TEXT,status TEXT,project_id TEXT,conversation_session_id TEXT); \
        CREATE TABLE memory_chunk_sources(source_id TEXT PRIMARY KEY,episode_id TEXT,revision TEXT,source_kind TEXT,origin_kind TEXT,role TEXT,basis TEXT,observed_at TEXT,conversation_message_id TEXT); \
        CREATE TABLE memory_aliases(node_id TEXT,surface_original TEXT,nfc_key TEXT,folded_key TEXT,source_id TEXT); \
        CREATE TABLE memory_alias_postings(gram TEXT,node_id TEXT,source_id TEXT,surface_original TEXT); \
        CREATE TABLE memory_claims(node_id TEXT,valid_from TEXT,valid_to TEXT); \
        CREATE TABLE memory_evidence(node_id TEXT,source_id TEXT);").unwrap();
    db.execute(
        "INSERT INTO memory_chunks VALUES('e-current','r','active',NULL,NULL)",
        [],
    )
    .unwrap();
    for (id, surface) in [("a-weak", "abca"), ("z-exact", "abc")] {
        let source = format!("s-{id}");
        let episode = format!("e-{id}");
        db.execute("INSERT INTO memory_nodes VALUES(?1,'entity')", [id])
            .unwrap();
        db.execute(
            "INSERT INTO memory_chunks VALUES(?1,'r','active',NULL,NULL)",
            [&episode],
        )
        .unwrap();
        db.execute("INSERT INTO memory_chunk_sources VALUES(?1,?2,'r','conversation','user_input','user','user_statement','2026-01-01T00:00:00Z',?3)",
            rusqlite::params![source,episode,format!("m-{id}")]).unwrap();
        db.execute(
            "INSERT INTO memory_aliases VALUES(?1,?2,?2,?2,?3)",
            rusqlite::params![id, surface, source],
        )
        .unwrap();
        for gram in crate::cognition::lexical::folded_grams(surface) {
            db.execute(
                "INSERT INTO memory_alias_postings VALUES(?1,?2,?3,?4)",
                rusqlite::params![gram, id, source, surface],
            )
            .unwrap();
        }
        db.execute(
            "INSERT INTO memory_evidence VALUES(?1,?2)",
            rusqlite::params![id, source],
        )
        .unwrap();
    }
    let canonical_path = std::env::temp_dir().join(format!(
        "cognition-selector-canonical-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let canonical_db = Connection::open(&canonical_path).unwrap();
    for table in [
        "conversation_sessions",
        "conversation_bindings",
        "conversation_turns",
        "conversation_messages",
        "conversation_parts",
        "conversation_turn_outcomes",
        "conversation_projection_outbox",
        "conversation_schema_migrations",
    ] {
        canonical_db
            .execute(&format!("CREATE TABLE {table}(id TEXT)"), [])
            .unwrap();
    }
    drop(canonical_db);
    let canonical = ConversationSourceReader::open(&canonical_path).unwrap();
    let input:ExtractInput=serde_json::from_value(json!({"schema":"butler.memory-extract-input.v2","episode_ref":"e-current","revision":"r",
        "window_ref":"window","bound_project_id":null,"source_units":[{"ref":"current","text":"abc","role":"user",
        "observed_at":"2026-09-14T00:00:00Z","origin_kind":"user_input"}],"context_units":[],"candidates":[]})).unwrap();
    let result = select(
        &db,
        &canonical,
        &input,
        "abc",
        &Vec::<VectorHit>::new(),
        i64::MAX,
    )
    .unwrap();
    let golden: Value =
        serde_json::from_str(include_str!("../fixtures/semantic-selector-bun.json")).unwrap();
    assert_eq!(json!(result.all_seeds), golden["allSeeds"]);
    let ranks=json!(result.ranks.iter().map(|(id,channels)| {
        (id.clone(),json!({"alias":channels.get(&Channel::Alias),"lexical":channels.get(&Channel::Lexical)}))
    }).collect::<HashMap<_,_>>());
    assert_eq!(
        ranks["z-exact"]["alias"],
        golden["ranks"]["z-exact"]["alias"]
    );
    assert_eq!(
        ranks["z-exact"]["lexical"],
        golden["ranks"]["z-exact"]["lexical"]
    );
    assert_eq!(
        ranks["a-weak"]["lexical"],
        golden["ranks"]["a-weak"]["lexical"]
    );
    let exact = result.scores["z-exact"][&Channel::Lexical];
    let weak = result.scores["a-weak"][&Channel::Lexical];
    assert!((exact - golden["scores"]["z-exact"]["lexical"].as_f64().unwrap()).abs() < 1e-12);
    assert!((weak - golden["scores"]["a-weak"]["lexical"].as_f64().unwrap()).abs() < 1e-12);
    assert_eq!(json!(result.coverage_codes), golden["coverageCodes"]);
    canonical.close().unwrap();
    std::fs::remove_file(canonical_path).unwrap();
}
