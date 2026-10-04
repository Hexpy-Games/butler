use super::*;
use rusqlite::{Connection, params};

// 13,312 registrations in the project, plus unrelated owner-scale message history.
fn seed(data: &std::path::Path, project: &str, chat: &str) -> Vec<String> {
    let started = std::time::Instant::now();
    eprintln!("ARTIFACT-FIXTURE phase=seed_begin");
    let mut db =
        butler_platform::sqlite::open(data.join("app-server/butler-client.sqlite")).unwrap();
    let tx = db.transaction().unwrap();
    for i in 0..600 {
        tx.execute("INSERT INTO chats(id,title,kind,project_id,created_at,updated_at) VALUES(?1,'Other','chat',NULL,'now','now')",[format!("scale-chat-{i}")]).unwrap();
    }
    seed_history(&tx);
    eprintln!(
        "ARTIFACT-FIXTURE phase=history_complete rows=300000 elapsed_ms={}",
        started.elapsed().as_millis()
    );
    let mut ids = Vec::new();
    {
        let mut messages = tx.prepare("INSERT INTO messages(id,chat_id,turn_id,role,text,status,created_at,updated_at) VALUES(?1,?2,'origin-turn','assistant','','delivered','now','now')").unwrap();
        let mut files = tx.prepare("INSERT INTO message_files(id,kind,mime_type,safe_name,size_bytes,sha256,storage_name,created_at) VALUES(?1,'text','text/plain',?2,8,'revision',?1,'now')").unwrap();
        let mut attachments = tx
            .prepare("INSERT INTO message_attachments(message_id,file_id,position) VALUES(?1,?2,0)")
            .unwrap();
        for i in 0..13_312 {
            let id = format!("file-scale-{i:05}");
            let message = format!("artifact-message-{i}");
            let title = if i == 0 {
                "needle".into()
            } else if i < 257 {
                format!("needle-{i:03}")
            } else {
                format!("other-{i}")
            };
            messages.execute(params![message, chat]).unwrap();
            files.execute(params![id, title]).unwrap();
            attachments.execute(params![message, id]).unwrap();
            if i < 257 {
                ids.push(id);
            }
        }
    }
    // Reattachment must not inflate counts, and its latest delivered origin wins.
    tx.execute("INSERT INTO messages(id,chat_id,turn_id,role,text,status,created_at,updated_at) VALUES('reattached',?1,'latest-turn','assistant','','delivered','now','now')",[chat]).unwrap();
    tx.execute(
        "INSERT INTO message_attachments VALUES('reattached',?1,0)",
        [&ids[1]],
    )
    .unwrap();
    // User and failed assistant attachments are not delivered artifacts.
    for (id, role, status) in [
        ("user-file", "user", "delivered"),
        ("failed-file", "assistant", "failed"),
    ] {
        tx.execute("INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at) VALUES(?1,?2,?3,'',?4,'now','now')",params![id,chat,role,status]).unwrap();
        tx.execute("INSERT INTO message_files(id,kind,mime_type,safe_name,size_bytes,sha256,storage_name,created_at) VALUES(?1,'text','text/plain','needle',8,'revision',?1,'now')",[id]).unwrap();
        tx.execute("INSERT INTO message_attachments VALUES(?1,?1,0)", [id])
            .unwrap();
    }
    tx.commit().unwrap();
    eprintln!(
        "ARTIFACT-FIXTURE phase=seed_committed registrations=13312 elapsed_ms={}",
        started.elapsed().as_millis()
    );
    let plan: Vec<String> = db.prepare("EXPLAIN QUERY PLAN SELECT m.id FROM chats c JOIN messages m ON m.chat_id=c.id WHERE c.project_id=?1 AND m.role='assistant'").unwrap()
        .query_map([project], |r| r.get(3)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    assert!(
        plan.iter()
            .any(|s| s.contains("chats_project_artifacts_idx")),
        "{plan:?}"
    );
    let mut ordered = vec![ids[0].clone(), ids[1].clone()];
    ordered.extend(ids[2..].iter().rev().cloned());
    ordered
}

fn seed_history(db: &Connection) {
    let started = std::time::Instant::now();
    let text = "x".repeat(4096);
    for start in (0..300_000).step_by(50_000) {
        // Generate the identical complete history inside SQLite, avoiding
        // 300,000 FFI/binding/string-allocation round trips on the test worker.
        db.execute("WITH RECURSIVE n(i) AS (SELECT ?1 UNION ALL SELECT i+1 FROM n WHERE i+1<?2)
          INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at)
          SELECT 'history-'||i,'scale-chat-'||(i%600),'assistant',?3,'delivered','now','now' FROM n",
          params![start, start + 50_000, text]).unwrap();
        eprintln!(
            "ARTIFACT-FIXTURE phase=history rows={} elapsed_ms={}",
            start + 50_000,
            started.elapsed().as_millis()
        );
    }
    let complete: bool = db.query_row("SELECT COUNT(*)=300000 AND COUNT(DISTINCT chat_id)=600 AND MIN(length(text)=4096 AND text=?1 AND chat_id='scale-chat-'||(CAST(substr(id,9) AS INTEGER)%600) AND role='assistant' AND status='delivered') FROM messages WHERE id LIKE 'history-%'", [&text], |row| row.get(0)).unwrap();
    assert!(
        complete,
        "owner-scale history must retain every complete row"
    );
}

#[tokio::test]
async fn many_matches_page_completely_at_owner_scale() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("PROJECT-ARTIFACT-PAGES")?
        .stub_cassette(stub::cassette()?)
        .start()
        .await?;
    eprintln!("ARTIFACT-FIXTURE phase=agent_ready");
    let p = project(&s, "Large project").await?;
    let a = chat(&s, &p).await?;
    let data = s.sandbox.data.clone();
    let seed_project = p.clone();
    let seed_chat = a.clone();
    let expected = tokio::task::spawn_blocking(move || seed(&data, &seed_project, &seed_chat))
        .await
        .unwrap();
    eprintln!("ARTIFACT-FIXTURE phase=before_reader");
    let b = chat(&s, &p).await?;
    eprintln!("ARTIFACT-FIXTURE phase=reader_ready");
    let mut actual = Vec::new();
    for (index, prompt) in ["Page1", "Page2", "Page3"].iter().enumerate() {
        let page = lookup(&s, &b, prompt).await?;
        assert_eq!(page["total_count"], 257, "{page}");
        let items = page["items"].as_array().unwrap();
        assert_eq!(items.len(), if index < 2 { 100 } else { 57 });
        actual.extend(items.iter().map(|i| i["id"].as_str().unwrap().to_owned()));
        assert!(items.iter().all(|i| i["type"] == "text/plain"
            && i["size_bytes"] == 8
            && i["origin_session"] == a));
        if index == 0 {
            assert_eq!(items[1]["origin_turn"], "latest-turn");
        }
        if index < 2 {
            s.provider()?
                .add_placeholder("CURSOR", page["next_cursor"].as_str().unwrap());
        } else {
            assert!(page["next_cursor"].is_null());
        }
    }
    assert_eq!(actual, expected);
    assert_eq!(
        actual
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        257
    );
    let other_project = project(&s, "Cursor boundary").await?;
    let other = chat(&s, &other_project).await?;
    assert_eq!(
        lookup(&s, &other, "Page4").await?["error"],
        "invalid_cursor"
    );
    let index =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))
            .unwrap();
    index
        .execute(
            "UPDATE message_files SET sha256='new-revision' WHERE id=?1",
            [&expected[0]],
        )
        .unwrap();
    assert_eq!(lookup(&s, &b, "Changed").await?["error"], "source_changed");
    index
        .execute(
            "UPDATE message_files SET safe_name=safe_name || ?1 WHERE safe_name LIKE 'needle-%'",
            ["x".repeat(230)],
        )
        .unwrap();
    let mut all = Vec::new();
    let mut pages = 0;
    loop {
        let page = lookup(&s, &b, if pages == 0 { "LongFirst" } else { "Long" }).await?;
        assert_eq!(page["total_count"], 257);
        let items = page["items"].as_array().unwrap();
        assert!(!items.is_empty() && items.len() <= 100);
        all.extend(items.iter().map(|i| i["id"].as_str().unwrap().to_owned()));
        pages += 1;
        if page["next_cursor"].is_null() {
            break;
        }
        assert!(pages < 10, "metadata pagination did not advance");
        s.provider()?
            .add_placeholder("CURSOR", page["next_cursor"].as_str().unwrap());
    }
    assert_eq!(all, expected);
    assert!(pages > 3, "long titles must continue without field loss");
    eprintln!("project artifact long metadata: 257/257 items in {pages} pages");
    drop(index);
    let db = s.sandbox.data.join("app-server/butler-client.sqlite");
    eprintln!(
        "project artifact scale: 600 unrelated chats, 300000 unrelated messages, 13312 registrations, 257/257 matches in 3 pages, db_bytes={}",
        fs::metadata(db)?.len()
    );
    s.finish().await
}
