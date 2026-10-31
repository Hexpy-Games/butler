//! Project delete acknowledges canon and cleanup independently, without restart.
use super::*;
use butler_e2e::e2e::{provider::Provider, security::AdminClient};
use std::time::Instant;

#[tokio::test]
async fn project_delete_releases_canon_without_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    check_delete(false).await
}

#[tokio::test]
async fn project_delete_canon_failure_recovers() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    check_delete(true).await
}

async fn check_delete(fail_canon: bool) -> Result<(), HarnessError> {
    let (mut s, script, server, epic, first) =
        crate::canon_link::setup("PROJECT-DELETE-CANON", false, false).await?;
    let (project, fixtures, provider) = artifacts(&mut s, first).await?;
    let db = app(&s)?;
    let canon = sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    seed(&db, &canon, &fixtures, &epic)?;
    if fail_canon {
        canon.execute_batch("CREATE TRIGGER refuse_delete BEFORE DELETE ON canon_session_epics BEGIN SELECT RAISE(ABORT,'storage unavailable'); END;")?;
    }
    let mut host = owners(&s, &fixtures).await?;
    let reply =
        s.gw.delete(&format!("/projects/{project}?permanent=true"))
            .await?;
    eprintln!(
        "project delete: status={} initiated_leftovers={} bindings={} receipts={}",
        reply.status,
        count(&db, "app_initiated_messages"),
        count(&canon, "canon_session_epics"),
        count(&db, "app_canon_session_deletes")
    );
    assert_eq!(
        reply.status,
        if fail_canon { 500 } else { 200 },
        "{reply:?}"
    );
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM projects WHERE id=?1",
            [&project],
            |r| r.get(0)
        )?,
        0
    );
    assert_eq!(count(&db, "chats"), 1, "only General remains");
    assert_eq!(
        count(&db, "app_initiated_messages"),
        0,
        "initiated messages leaked"
    );
    for fixture in &fixtures {
        recovered(&s, fixture)?;
    }
    let closed = closed_owners(&mut host).await?;
    for fixture in &fixtures {
        assert!(
            closed.contains(&fixture.chat),
            "owner was not closed: {}",
            fixture.chat
        );
    }
    if fail_canon {
        recover_canon(&s, &db, &canon, &fixtures, &epic).await?;
    }
    assert_released(&db, &canon, &fixtures)?;
    script.release();
    take_epic(&s, &epic).await?;
    s.finish().await?;
    provider.finish().await?;
    server.abort();
    Ok(())
}

async fn artifacts(
    s: &mut Scenario,
    first: String,
) -> Result<(String, [Deleted; 2], Provider), HarnessError> {
    let base_url = s
        .agent
        .launch
        .env
        .iter()
        .find(|(key, _)| key == "BUTLER_CHATGPT_API_BASE_URL")
        .unwrap()
        .1
        .clone();
    // Keep the epic's owning project available for the post-delete canon change.
    let created =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Conversations"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{created:?}");
    let project = created.data()["project"]["id"].as_str().unwrap().to_owned();
    app(s)?.execute(
        "UPDATE chats SET project_id=?1 WHERE id=?2",
        params![project, first],
    )?;
    let created =
        s.gw.post("/sessions", json!({"kind":"project","project_id":project}))
            .await?;
    assert_eq!(created.status, 201, "{created:?}");
    let second = created.data()["session"]["id"].as_str().unwrap().to_owned();
    let (one, provider) = canon::artifacts(s, first).await?;
    let two = inject_chat(s, second).await?;
    let fixtures = [one, two];
    s.agent.terminate().await?;
    s.agent
        .launch
        .set_env("BUTLER_CHATGPT_API_BASE_URL", base_url);
    s.gw = s.agent.start_again().await?;
    outputs(s)?.execute_batch("DROP TRIGGER fail_delete")?;
    Ok((project, fixtures, provider))
}

async fn recover_canon(
    s: &Scenario,
    db: &Connection,
    canon: &Connection,
    fixtures: &[Deleted; 2],
    epic: &str,
) -> Result<(), HarnessError> {
    assert_eq!(count(db, "app_canon_session_deletes"), 2);
    for fixture in fixtures {
        let hint: String = db.query_row(
            "SELECT session_hint FROM app_canon_session_deletes WHERE op_id=?1",
            [format!("session-delete:{}", fixture.chat)],
            |r| r.get(0),
        )?;
        assert_eq!(hint, fixture.hint);
    }
    assert_eq!(count(canon, "canon_session_epics"), 3);
    assert_eq!(intent_state(canon)?, "pending");
    canon.execute_batch("DROP TRIGGER refuse_delete")?;
    change_canon(s, epic).await?;
    let deadline = Instant::now() + Duration::from_secs(5);
    while count(db, "app_canon_session_deletes") != 0 {
        assert!(
            Instant::now() < deadline,
            "canon receipts were not replayed"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok(())
}

async fn take_epic(s: &Scenario, epic: &str) -> Result<(), HarnessError> {
    let target = chat(s).await?;
    let started =
        s.gw.post(
            &format!("/sessions/{target}/canon/queue"),
            json!({"op":"start_now","epic_id":epic}),
        )
        .await?;
    assert_eq!(started.status, 200, "{started:?}");
    assert_ne!(started.data()["code"], "held_elsewhere", "{started:?}");
    assert_eq!(
        started.data()["chains"].as_array().unwrap().len(),
        1,
        "{started:?}"
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    let turn = loop {
        if let Some(turn) = s.gw.turns(&target).await?.first() {
            break turn["id"].as_str().unwrap().to_owned();
        }
        assert!(Instant::now() < deadline, "new chat did not start epic");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    s.gw.wait_terminal(&target, &turn, Duration::from_secs(60))
        .await?;
    Ok(())
}

fn seed(
    db: &Connection,
    canon: &Connection,
    fixtures: &[Deleted; 2],
    epic: &str,
) -> Result<(), HarnessError> {
    // Same epic in both chats exercises independent failure attempts for each.
    canon.execute("INSERT INTO canon_session_epics(session_id,epic_id,is_home,bound_at,bound_by,origin) VALUES(?1,?2,0,0,'{}','user')",
        params![fixtures[1].hint, epic])?;
    let other: String =
        canon.query_row("SELECT id FROM canon_epics WHERE id<>?1", [epic], |r| {
            r.get(0)
        })?;
    for (fixture, queued_epic) in fixtures.iter().zip([epic, other.as_str()]) {
        db.execute("INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at,retryable) VALUES(?1,?1,'assistant','Held','delivered','2026-01-01','2026-01-01',0)", [&fixture.chat])?;
        db.execute("INSERT INTO app_initiated_messages(id,chat_id,kind,source_key,text,payload_json,state,message_id,created_at) VALUES(?1,?1,'canon_hold',?1,'Held','{}','posted',?1,'2026-01-01')", [&fixture.chat])?;
        canon.execute("INSERT INTO canon_session_queue(session_id,epic_id,chain_id,step_index,stack_position,state,origin) VALUES(?1,?2,?1,0,0,'held','user_message')",
            params![fixture.hint, queued_epic])?;
    }
    assert_eq!(count(db, "app_initiated_messages"), 2);
    assert_eq!(count(canon, "canon_session_queue"), 2);
    db.execute_batch("CREATE TRIGGER reject_panel BEFORE INSERT ON app_initiated_messages WHEN NEW.kind='canon_hold' BEGIN SELECT RAISE(ABORT,'projection unavailable'); END;")?;
    canon.execute("INSERT INTO canon_intents(op_id,kind,payload_json,state,revision,created_at) VALUES('project-delete-pending','canon_hold',?1,'pending',1,0)",
        [json!({"session_id":fixtures[0].hint,"epic_id":epic,"epic_title":"Held","state":"pending"}).to_string()])?;
    assert_eq!(intent_state(canon)?, "pending");
    Ok(())
}

async fn owners(s: &Scenario, fixtures: &[Deleted; 2]) -> Result<reqwest::Response, HarnessError> {
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let host = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", admin.gw.base))
        .bearer_auth(&admin.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    assert_eq!(host.status(), 200);
    let tabs: Vec<_> = fixtures.iter().map(|f| json!({"id":f.chat,"owner":format!("conversation:{}",f.chat),"profile":"signed_out","epoch":1,"holder":"agent","url":"https://example.com/"})).collect();
    let snapshot = admin
        .send(
            reqwest::Method::POST,
            "/internal/browser-host/events",
            Some(json!({"tabs":tabs})),
            &[],
        )
        .await?;
    assert_eq!(snapshot.status, 200);
    Ok(host)
}

async fn closed_owners(host: &mut reqwest::Response) -> Result<Vec<String>, HarnessError> {
    tokio::time::timeout(Duration::from_secs(8), async {
        let mut buffer = String::new();
        let mut closed = Vec::new();
        loop {
            if let Some(end) = buffer.find("\n\n") {
                let event = buffer[..end].to_owned();
                buffer.drain(..end + 2);
                if let Some(data) = event.lines().find_map(|line| line.strip_prefix("data: ")) {
                    let frame: serde_json::Value = serde_json::from_str(data)?;
                    if frame["op"] == "owner.closed" {
                        closed.push(frame["session"].as_str().unwrap().to_owned());
                        if closed.len() == 2 {
                            return Ok(closed);
                        }
                    }
                }
            } else {
                let bytes = host.chunk().await?.expect("host connected");
                buffer.push_str(std::str::from_utf8(&bytes).unwrap());
            }
        }
    })
    .await
    .expect("both committed owners must close")
}

fn intent_state(canon: &Connection) -> rusqlite::Result<String> {
    canon.query_row(
        "SELECT state FROM canon_intents WHERE op_id='project-delete-pending'",
        [],
        |r| r.get(0),
    )
}

async fn change_canon(s: &Scenario, epic: &str) -> Result<(), HarnessError> {
    let path = format!("/canon/epics/{epic}");
    let row = s.gw.get(&path).await?;
    assert_eq!(row.status, 200, "{row:?}");
    let changed =
        s.gw.patch(
            &path,
            json!({"expected_revision":row.data()["revision"],"title":"Changed"}),
        )
        .await?;
    assert_eq!(changed.status, 200, "{changed:?}");
    Ok(())
}

fn assert_released(
    db: &Connection,
    canon: &Connection,
    fixtures: &[Deleted; 2],
) -> Result<(), HarnessError> {
    assert_eq!(count(db, "app_canon_session_deletes"), 0);
    assert_eq!(count(db, "app_session_delete_cleanups"), 0);
    for fixture in fixtures {
        for table in ["canon_session_epics", "canon_session_queue"] {
            let left: i64 = canon.query_row(
                &format!("SELECT count(*) FROM {table} WHERE session_id=?1"),
                [&fixture.hint],
                |r| r.get(0),
            )?;
            assert_eq!(left, 0, "{table} retained {}", fixture.chat);
        }
    }
    assert_eq!(intent_state(canon)?, "applied");
    Ok(())
}
