//! History compatibility and change invalidation through the real monitor route.
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use butler_platform::sqlite;
use rusqlite::params;
use serde_json::json;

pub(super) async fn assert_history_labels(s: &Scenario) -> Result<(), HarnessError> {
    let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite")).unwrap();
    db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    for (index, title) in ["Old report", "Table", "Code", "Note", "Old report"]
        .iter()
        .enumerate()
    {
        let id = format!("history-file-{index}");
        db.execute("INSERT INTO message_files(id,kind,mime_type,safe_name,size_bytes,sha256,storage_name,created_at) \
          VALUES(?1,'text','text/plain',?2,0,'hash',?1,'2026-01-01')",params![id,title]).unwrap();
        db.execute(
            "INSERT INTO message_attachments(message_id,file_id,position) VALUES(?1,?2,0)",
            params![format!("monitor-m{}", 69000 + index), id],
        )
        .unwrap();
    }
    db.execute_batch("INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at)
      VALUES('ancient-opaque-ref','monitor-c23','user','Earlier reference','delivered','2026-01-01','2026-01-01'),
      ('history-final','monitor-c23','assistant','Done ancient-opaque-ref /tmp/private/report','delivered','2026-01-01','2026-01-01'),
      ('history-blank','monitor-c23','assistant',char(9)||char(10)||char(12288),'delivered','2026-01-01','2026-01-01'),
      ('history-stream','monitor-c23','assistant','Unfinished report','streaming','2026-01-01','2026-01-01');").unwrap();
    let reply = s.gw.get("/work-status").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(
        reply.data()["items"][0]["latest_report_summary"],
        "Done internal reference local reference"
    );
    assert_eq!(
        reply.data()["items"][0]["recent_artifacts"],
        json!(["Table", "Code", "Note"])
    );
    // Complete an existing streaming row: MAX(rowid) and chat.updated_at stay unchanged.
    db.execute(
        "UPDATE messages SET status='delivered',text='Newest report' WHERE id='history-stream'",
        [],
    )
    .unwrap();
    let reply = s.gw.get("/work-status").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(
        reply.data()["items"][0]["latest_report_summary"],
        "Newest report"
    );
    db.execute(
        "UPDATE message_files SET safe_name='Updated table' WHERE id='history-file-1'",
        [],
    )
    .unwrap();
    let reply = s.gw.get("/work-status").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(
        reply.data()["items"][0]["recent_artifacts"],
        json!(["Updated table", "Code", "Note"])
    );
    Ok(())
}
