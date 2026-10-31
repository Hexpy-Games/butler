//! Project deletion closes committed chat owners even when cleanup fails.
use super::*;
use butler_e2e::e2e::security::AdminClient;

#[tokio::test]
async fn project_delete_closes_preview_owner() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    check_project_owner(false).await
}

#[tokio::test]
async fn project_delete_failed_cleanup_closes_preview_owner() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    check_project_owner(true).await
}

async fn check_project_owner(fail_cleanup: bool) -> Result<(), HarnessError> {
    let setup = setup("PROJECT-DELETE-OWNER")?.env("PATH", std::env::var("PATH").unwrap());
    let cwd = setup.sandbox.workspace.clone();
    std::fs::write(
        cwd.join("server.mjs"),
        "Bun.serve({hostname:'127.0.0.1',port:Number(process.argv[2]),fetch(){return new Response('ready')}});",
    )?;
    let mut s = setup.start().await?;
    let created =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Cleanup"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{created:?}");
    let project = created.data()["project"]["id"].as_str().unwrap().to_owned();
    let created =
        s.gw.post("/sessions", json!({"kind":"project","project_id":project}))
            .await?;
    assert_eq!(created.status, 201, "{created:?}");
    let chat = created.data()["session"]["id"].as_str().unwrap().to_owned();
    let fixture = inject_chat(&mut s, chat).await?;
    if !fail_cleanup {
        outputs(&s)?.execute_batch("DROP TRIGGER fail_delete")?;
    }
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let port = super::super::browser_preview::port();
    let started = super::super::browser_preview::call(&admin, &fixture.chat, "preview.start",
        json!({"agent":"preview-agent","preview_id":"project-owner","command":format!("bun server.mjs {port}"),"cwd":cwd,"port":port})).await?;
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
        Some(json!({"tabs":[{"id":"project-tab","owner":format!("conversation:{}", fixture.chat),"profile":"signed_out","epoch":1,"holder":"agent","url":"https://example.com/"}]})), &[]).await?;
    assert_eq!(snapshot.status, 200);
    app(&s)?.execute_batch("CREATE TRIGGER refuse_delete BEFORE DELETE ON chats BEGIN SELECT RAISE(ABORT,'injected'); END;")?;
    let path = format!("/projects/{project}?permanent=true");
    let refused = s.gw.delete(&path).await?;
    assert_eq!(refused.status, 500, "{refused:?}");
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok(),
        "pre-commit failure closed owner"
    );
    app(&s)?.execute_batch("DROP TRIGGER refuse_delete")?;
    let reply = s.gw.delete(&path).await?;
    assert_eq!(
        reply.status,
        if fail_cleanup { 500 } else { 200 },
        "{reply:?}"
    );
    assert_eq!(
        app(&s)?.query_row(
            "SELECT count(*) FROM projects WHERE id=?1",
            [&project],
            |r| r.get::<_, i64>(0)
        )?,
        0
    );
    assert_eq!(
        count(&*app(&s)?, "app_session_delete_cleanups"),
        i64::from(fail_cleanup)
    );
    let notice = project_owner::owner_notice(&mut host).await?;
    assert_eq!(notice["session"], fixture.chat);
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_err(),
        "committed project delete left preview running"
    );
    s.finish().await
}
