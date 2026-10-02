//! Extend the existing schema pin with dictionary ownership and transactional writes.
use rusqlite::Connection;

pub(super) fn pin() {
    let mut db = Connection::open_in_memory().unwrap();
    db.pragma_update(None, "foreign_keys", true).unwrap();
    super::super::ensure(&mut db, "2026-01-01").unwrap();
    db.execute_batch("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,origin_kind,status,source_hash,created_at,updated_at) VALUES('e','e','1','user_input','active','hash','2026-01-01','2026-01-01'); INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES('s','e','1','conversation','text','/text',0,100,'hash','user','user_input','2026-01-01','user_statement'); INSERT INTO memory_nodes(id,type,label_original,identity_scope,created_at) VALUES('n','entity','abc','global','2026-01-01')").unwrap();
    {
        let tx = db.transaction().unwrap();
        insert(&tx, "abc");
        super::super::super::recall_index::install_and_backfill(&tx).unwrap();
        assert_counts(&tx, 1, 3);
        tx.rollback().unwrap();
    }
    assert_counts(&db, 0, 0);
    insert(&db, "abc");
    super::super::super::recall_index::install_and_backfill(&db).unwrap();
    assert_counts(&db, 1, 3);
    db.execute("UPDATE memory_aliases SET surface_original='def',nfc_key='def',folded_key='def' WHERE node_id='n'",[]).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM memory_alias_documents", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    super::super::super::recall_index::install_and_backfill(&db).unwrap();
    assert_counts(&db, 1, 3);
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM memory_alias_grams WHERE gram IN ('ab','bc','abc')",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    db.execute("DELETE FROM memory_aliases", []).unwrap();
    assert_counts(&db, 0, 0);
    assert_eq!(db.query_row("SELECT COUNT(*) FROM sqlite_schema WHERE name LIKE 'idx_alias_postings_%' OR name='memory_alias_index_scope'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert!(db.execute("INSERT INTO memory_alias_documents(node_id,source_id,surface_original) VALUES('n','s','orphan')",[]).is_err());
    dual_pin(db);
}
fn insert(db: &Connection, text: &str) {
    db.execute("INSERT INTO memory_aliases(node_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES('n',?1,?1,?1,'s','literal')",[text]).unwrap();
}
fn assert_counts(db: &Connection, aliases: i64, grams: i64) {
    let counts: (i64,i64,i64)=db.query_row("SELECT (SELECT COUNT(*) FROM memory_aliases),(SELECT COUNT(*) FROM memory_alias_documents),(SELECT COUNT(*) FROM memory_alias_grams)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(counts, (aliases, aliases, grams));
}

fn dual_pin(db: Connection) {
    db.execute_batch("DROP VIEW memory_alias_postings; DROP TRIGGER memory_alias_documents_update; DROP TRIGGER memory_alias_index_insert; DROP TRIGGER memory_alias_index_update; DROP TRIGGER memory_alias_index_delete; DROP TABLE memory_alias_grams; DROP TABLE memory_alias_documents; DELETE FROM memory_state WHERE key='alias_postings_v2'; CREATE TABLE memory_alias_postings(gram TEXT NOT NULL,node_id TEXT NOT NULL,source_id TEXT NOT NULL,surface_original TEXT NOT NULL,identity_scope TEXT NOT NULL,project_id TEXT,PRIMARY KEY(gram,node_id,source_id,surface_original))").unwrap();
    insert(&db, "abc");
    super::super::super::recall_index::install_and_backfill(&db).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let _entered = runtime.enter();
    let mut graph = super::super::super::GraphRepository {
        connection: Some(db),
    };
    let stop = tokio_util::sync::CancellationToken::new();
    assert!(graph.advance_alias_postings(&stop).unwrap());
    assert!(!graph.advance_alias_postings(&stop).unwrap());
    let db = graph.connection().unwrap();
    assert_counts(db, 1, 3);
    for mutation in [
        "UPDATE memory_aliases SET surface_original='def',folded_key='def',nfc_key='def'",
        "UPDATE memory_nodes SET identity_scope='project',project_id='project-0'",
        "DELETE FROM memory_aliases",
    ] {
        db.execute_batch(mutation).unwrap();
        super::super::super::recall_index::install_and_backfill(db).unwrap();
        let mismatch: i64 = db.query_row("SELECT COUNT(*) FROM (SELECT gram,node_id,source_id,surface_original FROM memory_alias_postings EXCEPT SELECT * FROM memory_alias_read_postings)", [], |r| r.get(0)).unwrap();
        let missing: i64 = db.query_row("SELECT COUNT(*) FROM (SELECT * FROM memory_alias_read_postings EXCEPT SELECT gram,node_id,source_id,surface_original FROM memory_alias_postings)", [], |r| r.get(0)).unwrap();
        assert_eq!((mismatch, missing), (0, 0));
        let aliases: i64 = db
            .query_row("SELECT COUNT(*) FROM memory_aliases", [], |r| r.get(0))
            .unwrap();
        assert_counts(db, aliases, if aliases == 0 { 0 } else { 3 });
    }
    db.execute_batch("INSERT INTO memory_alias_postings VALUES('zz','n','s','obsolete','global',NULL); UPDATE memory_state SET value='copy' WHERE key='alias_postings_v2'; INSERT INTO memory_state VALUES('alias_postings_v2_cursor','[\"\",\"\",\"\"]')").unwrap();
    assert!(
        graph.advance_alias_postings(&stop).is_err(),
        "orphan legacy postings were silently dropped at flip"
    );
    assert_eq!(
        graph
            .connection()
            .unwrap()
            .query_row(
                "SELECT value FROM memory_state WHERE key='alias_postings_v2'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "copy"
    );
}
