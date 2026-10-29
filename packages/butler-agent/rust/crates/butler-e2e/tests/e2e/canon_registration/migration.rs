use super::*;

#[tokio::test]
async fn pre_existing_bindings_keep_their_home_chats_after_migration() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, _, server, project, _) = setup("CP-home-migration", Access::AskAlways).await?;
    let chat = data(
        s.gw.post(
            "/sessions",
            json!({"title":"기존 프로젝트 대화","kind":"project","project_id":project}),
        )
        .await?,
        201,
    )["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut epics = Vec::new();
    for title in ["기존 과제 하나", "기존 과제 둘"] {
        let epic = data(
            s.gw.post(
                &format!("/projects/{project}/canon/epics"),
                json!({"title":title}),
            )
            .await?,
            201,
        );
        let id = epic["id"].as_str().unwrap().to_owned();
        let linked = data(
            s.gw.post(
                &format!("/canon/epics/{id}/conversation"),
                json!({"session_id":chat}),
            )
            .await?,
            200,
        );
        assert_eq!(linked["work"]["home_session_id"], chat);
        epics.push(id);
    }
    s.agent.terminate().await?;
    let db = butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.execute_batch("ALTER TABLE canon_session_epics DROP COLUMN is_home")?;
    drop(db);
    s.gw = s.agent.start_again().await?;
    for id in &epics {
        let epic = data(s.gw.get(&format!("/canon/epics/{id}")).await?, 200);
        assert_eq!(epic["home_session_id"], chat);
        assert_eq!(epic["sessions"][0]["is_home"], 1);
    }
    server.abort();
    s.finish().await
}
