use super::*;

#[tokio::test]
async fn failed_apply_removes_only_its_new_empty_workspace() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server, project, chat) = setup("CP-cleanup", Access::AskAlways).await?;
    let epic = data(
        s.gw.post(
            &format!("/projects/{project}/canon/epics"),
            json!({"title":"기존 과제"}),
        )
        .await?,
        201,
    );
    let root = s.sandbox.home.join("butler-workspace");
    for existing in [false, true] {
        let id = draft(&s, &script, &chat, json!({"project_id":project,"summary":"과제 변경","changes":[{"op":"epic.edit","id":epic["id"],"expected_revision":epic["revision"],"title":"변경"}]})).await?;
        let folder = root.join(format!("project-canon-{id}"));
        if existing {
            std::fs::create_dir_all(&folder)?;
        }
        let reply =
            s.gw.post(
                &format!("/canon/proposals/{id}"),
                json!({"outcome":"accepted","new_name":"다른 프로젝트"}),
            )
            .await?;
        assert!(
            reply.status >= 400,
            "cross-project edit must fail: {}",
            reply.text
        );
        assert_eq!(
            folder.exists(),
            existing,
            "only a folder created by this apply may be removed"
        );
        assert_eq!(read(&s, &id).await?["state"], "open");
    }
    let id = draft(&s, &script, &chat, json!({"project_id":project,"summary":"변경 확인","changes":[{"op":"epic.edit","id":epic["id"],"expected_revision":epic["revision"],"title":"변경"}]})).await?;
    s.agent.terminate().await?;
    let release = s.sandbox.data.join("cleanup-release");
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_POINT", "canon_write");
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_RELEASE", release.to_string_lossy());
    s.gw = s.agent.start_again().await?;
    let gw = s.gw.clone();
    let proposal = id.clone();
    let applying = tokio::spawn(async move {
        gw.post(
            &format!("/canon/proposals/{proposal}"),
            json!({"outcome":"accepted","new_name":"다른 제품"}),
        )
        .await
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while !release.with_extension("held").exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "apply did not reach its hold"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let folder = root.join(format!("project-canon-{id}"));
    std::fs::write(folder.join("keep.txt"), "새 내용")?;
    std::fs::write(release, "continue")?;
    assert!(
        applying
            .await
            .map_err(|e| HarnessError(e.to_string()))??
            .status
            >= 400
    );
    assert_eq!(std::fs::read_to_string(folder.join("keep.txt"))?, "새 내용");
    server.abort();
    s.finish().await
}
