use super::*;
mod requires_e2e_fixtures {
    use super::*;
    #[tokio::test]
    async fn cp_project_create_crash_recovers_one_project_with_its_epic() -> Result<(), HarnessError>
    {
        butler_e2e::gate!();
        let (mut s, script, server, _, chat) = setup("CP-crash", Access::AskAlways).await?;
        let id=draft(&s,&script,&chat,json!({"project_ref":"@new","summary":"원자 등록","changes":[{"op":"project.create","name":"복구 프로젝트"},{"op":"epic.create","title":"복구 과제"}]})).await?;
        s.agent.terminate().await?;
        let release = s.sandbox.data.join("canon-release");
        s.agent
            .launch
            .set_env("BUTLER_E2E_HOLD_POINT", "canon_project_publish");
        s.agent
            .launch
            .set_env("BUTLER_E2E_HOLD_RELEASE", release.to_string_lossy());
        s.gw = s.agent.start_again().await?;
        let gw = s.gw.clone();
        let proposal = id.clone();
        let accepting = tokio::spawn(async move {
            gw.post(
                &format!("/canon/proposals/{proposal}"),
                json!({"outcome":"accepted"}),
            )
            .await
        });
        let held = release.with_extension("held");
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while !held.exists() {
            assert!(std::time::Instant::now() < deadline, "hold not reached");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let projects = data(s.gw.get("/projects").await?, 200);
        assert!(!projects.to_string().contains("복구 프로젝트"));
        let committed = read(&s, &id).await?;
        assert_eq!(
            committed["state"], "applied",
            "apply must commit before the crash"
        );
        s.agent.kill9()?;
        let _ = accepting.await;
        std::fs::write(&release, b"continue")?;
        s.gw = s.agent.start_again().await?;
        let live = LiveEvents::subscribe(&s.gw, 0).await?;
        live.wait_for(Duration::from_secs(20), |e| {
            e["type"] == "project.created"
                && e["payload"]["project"]["display_name"] == "복구 프로젝트"
        })
        .await?;
        assert_eq!(read(&s, &id).await?["state"], "applied");
        let result = accept(&s, &id).await?;
        let projects = data(s.gw.get("/projects").await?, 200);
        assert_eq!(
            projects["projects"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|p| p["display_name"] == "복구 프로젝트")
                .count(),
            1
        );
        let project = result["applied"][0]["project_id"].as_str().unwrap();
        assert_bound(&s, &chat, project, &epic_id(&result), "user").await?;
        server.abort();
        s.finish().await
    }
}
