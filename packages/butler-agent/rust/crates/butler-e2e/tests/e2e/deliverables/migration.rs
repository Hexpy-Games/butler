//! v4 removes only untouched documents, in a large legacy fixture.
use super::*;
use butler_platform::sqlite;
use std::time::Instant;

fn seed(data: &std::path::Path) -> rusqlite::Result<()> {
    let db = sqlite::open(data.join("app-server/butler-client.sqlite")).unwrap();
    super::super::app_storage_scale::seed::seed_scale(&db, 1, 1, 1);
    db.execute_batch("BEGIN;
        DELETE FROM browser_library_migration WHERE version=4;
        INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at) VALUES('legacy-message','general','assistant','Result','delivered','2026-01-01','2026-01-01');
        INSERT INTO browser_library_group(id,kind,name,name_key,position,created_at) VALUES('kept-group','document','Kept','kept',0,'2026-01-01');
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<20003)
        INSERT INTO message_files(id,owner_session_id,message_id,kind,mime_type,safe_name,size_bytes,sha256,storage_name,created_at)
        SELECT 'legacy-'||i,'general','legacy-message','text','text/plain','File',7,'unchanged','legacy-'||i,'2026-01-01' FROM n;
        INSERT INTO message_attachments(message_id,file_id,position) SELECT 'legacy-message',id,rowid FROM message_files;
        INSERT INTO browser_library(id,kind,title,url,payload,created_at,group_id)
        SELECT 'document-'||id,'document','File','/message-files/'||id,
            json_object('id','document-'||id,'kind','document','title','File','url','/message-files/'||id,'capturedAt','2026-01-01'), '2026-01-01',NULL FROM message_files;
        UPDATE browser_library SET payload=json_set(payload,'$.autoTitle','File') WHERE id='document-legacy-1';
        UPDATE browser_library SET group_id='kept-group' WHERE id='document-legacy-2';
        INSERT INTO browser_library_tag(norm,name) VALUES('kept','Kept');
        INSERT INTO browser_library_item_tag(item_id,norm) VALUES('document-legacy-3','kept');
        COMMIT;")?;
    let bytes = data.join("app-server/message-files");
    std::fs::create_dir_all(&bytes).unwrap();
    for n in 0..4 {
        std::fs::write(bytes.join(format!("legacy-{n}")), "payload").unwrap();
    }
    Ok(())
}
fn assert_preserved(data: &std::path::Path) {
    let db = sqlite::open(data.join("app-server/butler-client.sqlite")).unwrap();
    for table in ["message_files", "message_attachments"] {
        let count: u64 = db
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 20004);
    }
    let marker: u64 = db
        .query_row(
            "SELECT count(*) FROM browser_library_migration WHERE version=4",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(marker, 1);
    for n in 0..4 {
        assert_eq!(
            std::fs::read(data.join(format!("app-server/message-files/legacy-{n}"))).unwrap(),
            b"payload"
        );
    }
}
#[tokio::test]
async fn migration_v4_preserves_touched_rows_and_all_file_bytes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("DELIVERABLE-MIGRATION")?.start().await?;
    s.agent.terminate().await?;
    let data = s.sandbox.data.clone();
    tokio::task::spawn_blocking(move || seed(&data))
        .await
        .unwrap()?;
    let started = Instant::now();
    s.gw = s.agent.start_again().await?;
    let elapsed = started.elapsed();
    let docs = documents(&s).await?;
    assert_eq!(docs.len(), 3, "{docs:?}");
    let mut ids = docs
        .iter()
        .map(|d| d["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    ids.sort_unstable();
    assert_eq!(
        ids,
        [
            "document-legacy-1",
            "document-legacy-2",
            "document-legacy-3"
        ]
    );
    assert_preserved(&s.sandbox.data);
    eprintln!("v4 migration of 20004 document rows, including isolated agent startup: {elapsed:?}");
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    assert_eq!(documents(&s).await?, docs);
    assert_preserved(&s.sandbox.data);
    s.finish().await
}
