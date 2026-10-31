//! Project cleanup uses the same durable debt; committed failures close owners.
use super::*;
use butler_e2e::e2e::security::AdminClient;

#[tokio::test]
async fn project_delete_cleanup_recovers_on_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("PROJECT-DELETE-CLEANUP")?.start().await?;
    let created =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Cleanup"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{created:?}");
    let project = created.data()["project"]["id"].as_str().unwrap().to_owned();
    let mut fixtures = Vec::new();
    for _ in 0..2 {
        let created =
            s.gw.post("/sessions", json!({"kind":"project","project_id":project}))
                .await?;
        assert_eq!(created.status, 201, "{created:?}");
        let id = created.data()["session"]["id"].as_str().unwrap().to_owned();
        fixtures.push(inject_chat(&mut s, id).await?);
    }
    let archived =
        s.gw.post(
            &format!("/sessions/{}/archive", fixtures[0].chat),
            json!({}),
        )
        .await?;
    assert_eq!(archived.status, 500, "{archived:?}");
    let kind: String = app(&s)?.query_row(
        "SELECT kind FROM app_session_delete_cleanups WHERE session_id=?1",
        [&fixtures[0].chat],
        |row| row.get(0),
    )?;
    assert_eq!(kind, "archive");
    let reply =
        s.gw.delete(&format!("/projects/{project}?permanent=true"))
            .await?;
    assert_eq!(reply.status, 500, "{reply:?}");
    let db = app(&s)?;
    assert_eq!(count(&db, "chats"), 1, "only general remains");
    assert_eq!(count(&db, "app_session_delete_cleanups"), 2);
    for fixture in &fixtures {
        let (kind, hint): (String, String) = db.query_row(
            "SELECT kind,session_hint FROM app_session_delete_cleanups WHERE session_id=?1",
            [&fixture.chat],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(kind, "delete");
        assert_eq!(hint, fixture.hint);
        assert!(!fixture.upload.exists(), "message-file sweep skipped");
        assert!(!fixture.summary.exists(), "continuity cleanup skipped");
        assert!(!fixture.asset.exists(), "asset sweep skipped");
    }
    assert_eq!(count(&*outputs(&s)?, "outputs"), 2);
    s.agent.terminate().await?;
    outputs(&s)?.execute_batch("DROP TRIGGER fail_delete")?;
    s.gw = s.agent.start_again().await?;
    for fixture in &fixtures {
        recovered(&s, fixture)?;
    }
    s.finish().await
}

#[tokio::test]
async fn failed_cleanup_still_closes_owner() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for permanent in [true, false] {
        let setup = setup("FAILED-CLEANUP-OWNER")?.env("PATH", std::env::var("PATH").unwrap());
        let cwd = setup.sandbox.workspace.clone();
        std::fs::write(
            cwd.join("server.mjs"),
            "Bun.serve({hostname:'127.0.0.1',port:Number(process.argv[2]),fetch(){return new Response('ready')}});",
        )?;
        let mut s = setup.start().await?;
        let fixture = inject(&mut s).await?;
        let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
        let port = super::super::browser_preview::port();
        let args = json!({"agent":"preview-agent","preview_id":"cleanup-owner","command":format!("bun server.mjs {port}"),"cwd":cwd,"port":port});
        let started =
            super::super::browser_preview::call(&admin, &fixture.chat, "preview.start", args)
                .await?;
        assert_eq!(started["status"], "ok", "{started}");
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_ok()
        );
        let mut host = reqwest::Client::new()
            .get(format!("{}/internal/browser-host", admin.gw.base))
            .bearer_auth(&admin.gw.token)
            .header("x-butler-admin", &admin.admin)
            .send()
            .await?;
        assert_eq!(host.status(), 200);
        let snapshot = admin.send(reqwest::Method::POST, "/internal/browser-host/events",
            Some(json!({"tabs":[{"id":"cleanup-tab","owner":format!("conversation:{}", fixture.chat),"profile":"signed_out","epoch":1,"holder":"agent","url":"https://example.com/"}]})), &[]).await?;
        assert_eq!(snapshot.status, 200);
        app(&s)?.execute_batch("CREATE TRIGGER refuse_mutation BEFORE UPDATE ON chats BEGIN SELECT RAISE(ABORT,'injected'); END; CREATE TRIGGER refuse_delete BEFORE DELETE ON chats BEGIN SELECT RAISE(ABORT,'injected'); END;")?;
        let path = if permanent {
            format!("/sessions/{}?permanent=true", fixture.chat)
        } else {
            format!("/sessions/{}/archive", fixture.chat)
        };
        let refused = if permanent {
            s.gw.delete(&path).await?
        } else {
            s.gw.post(&path, json!({})).await?
        };
        assert_eq!(refused.status, 500, "{refused:?}");
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_ok(),
            "pre-commit failure closed owner"
        );
        app(&s)?.execute_batch("DROP TRIGGER refuse_mutation; DROP TRIGGER refuse_delete;")?;
        let reply = if permanent {
            s.gw.delete(&path).await?
        } else {
            s.gw.post(&path, json!({})).await?
        };
        assert_eq!(reply.status, 500, "{reply:?}");
        assert_eq!(count(&*app(&s)?, "app_session_delete_cleanups"), 1);
        let notice = owner_notice(&mut host).await?;
        assert_eq!(notice["session"], fixture.chat);
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_err(),
            "committed cleanup failure left preview running (permanent={permanent})"
        );
        s.finish().await?;
    }
    Ok(())
}

pub(super) async fn owner_notice(
    host: &mut reqwest::Response,
) -> Result<serde_json::Value, HarnessError> {
    tokio::time::timeout(Duration::from_secs(8), async {
        let mut buffer = String::new();
        loop {
            if let Some(end) = buffer.find("\n\n") {
                let event = buffer[..end].to_owned();
                buffer.drain(..end + 2);
                if let Some(data) = event.lines().find_map(|line| line.strip_prefix("data: ")) {
                    let frame: serde_json::Value = serde_json::from_str(data)?;
                    if frame["op"] == "owner.closed" {
                        return Ok(frame);
                    }
                }
            } else {
                let bytes = host.chunk().await?.expect("host connected");
                buffer.push_str(std::str::from_utf8(&bytes).unwrap());
            }
        }
    })
    .await
    .expect("committed failure must send owner.closed")
}
