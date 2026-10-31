use super::*;
#[tokio::test]
async fn cp_04_no_project_chat_new_project_is_atomic_and_idempotent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, _, chat) = setup("CP-04", Access::AskAlways).await?;
    let args = json!({"project_ref":"@new","summary":"새 프로젝트의 과제","changes":[{"op":"project.create","name":"새 제품","project_ref":"@new"},{"op":"epic.create","title":"첫 과제"}]});
    let id = draft(&s, &script, &chat, args).await?;
    assert_eq!(read(&s, &id).await?["project"]["new_name"], "새 제품");
    let result = accept(&s, &id).await?;
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(accept(&s, &id).await?, result);
    let projects = data(s.gw.get("/projects").await?, 200);
    let projects = projects["projects"].as_array().unwrap();
    assert_eq!(
        projects
            .iter()
            .filter(|p| p["display_name"] == "새 제품")
            .count(),
        1
    );
    let project = projects
        .iter()
        .find(|p| p["display_name"] == "새 제품")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    assert_bound(&s, &chat, project, &epic_id(&result), "user").await?;
    server.abort();
    s.finish().await
}
#[tokio::test]
async fn cp_05_auto_applies_with_record_without_an_open_ask() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for access in [Access::Auto, Access::FullAccess] {
        let (s, script, server, project, chat) = setup("CP-05", access).await?;
        run(
            &s,
            &script,
            &chat,
            "이 문제를 과제로 등록해",
            vec![("canon_propose", proposal(&project, "표시 오류"))],
        )
        .await?;
        assert_eq!(asks(&s, &chat).await?["open_count"], 0);
        assert_eq!(s.gw.approval_requests(&chat).await?, Vec::<Value>::new());
        let result = stub::results(&script)
            .into_iter()
            .find(|r| r["state"] == "applied")
            .expect("applied result");
        assert_bound(&s, &chat, &project, &epic_id(&result), "butler").await?;
        let view = data(
            s.gw.get(&format!("/session-view?session_id={chat}"))
                .await?,
            200,
        );
        let id = view["canon_proposals"][0]["proposal_id"].as_str().unwrap();
        assert_eq!(read(&s, id).await?["resolved_by"], Value::Null);
        server.abort();
        s.finish().await?;
    }
    Ok(())
}
#[tokio::test]
async fn cp_06_read_only_tool_stays_visible_and_refuses() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, chat) = setup("CP-06", Access::AskAlways).await?;
    data(
        s.gw.patch(
            &format!("/sessions/{chat}/controls"),
            json!({"access_mode":"read_only"}),
        )
        .await?,
        200,
    );
    run(
        &s,
        &script,
        &chat,
        "읽기 전용에서 등록해",
        vec![("canon_propose", proposal(&project, "권한 확인"))],
    )
    .await?;
    assert!(
        stub::results(&script)
            .iter()
            .any(|r| r["error"]["code"] == "read_only")
    );
    assert_eq!(asks(&s, &chat).await?["open_count"], 0);
    assert_eq!(s.gw.approval_requests(&chat).await?, Vec::<Value>::new());
    assert!(script.requests.lock().unwrap().iter().any(|request| {
        butler_e2e::e2e::chatgpt_wire::tools(request).any(|tool| tool["name"] == "canon_propose")
    }));
    let board = data(s.gw.get(&format!("/projects/{project}/canon")).await?, 200);
    assert_eq!(board["backlog"], json!([]));
    assert!(s.gw.messages(&chat).await?.iter().any(|m| {
        m["role"] == "assistant"
            && m["text"]
                .as_str()
                .is_some_and(|t| t.contains("읽기 전용이라 과제를 등록할 수 없으며"))
    }));
    server.abort();
    s.finish().await
}
#[tokio::test]
async fn cp_07_schedule_keeps_draft_open_and_never_waits() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, chat) = setup("CP-07", Access::AskAlways).await?;
    let message = "예약 작업에서 발견한 오류를 등록해";
    stub::arm(
        &script,
        message,
        vec![("canon_propose", proposal(&project, "예약 실행 오류"))],
    );
    let created=data(s.gw.post("/automations",json!({"title":"등록 확인","prompt_body":message,"target_session_id":chat,"interval_seconds":3600,"access_mode":"ask_first"})).await?,201);
    let id = created["automation"]["id"].as_str().unwrap();
    let run = data(
        s.gw.post(&format!("/automations/{id}/run"), json!({}))
            .await?,
        202,
    );
    let turn = run["run"]["turn_id"].as_str().unwrap();
    let result =
        s.gw.wait_terminal(&chat, turn, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&result), "delivered", "{result}");
    assert_eq!(asks(&s, &chat).await?["asks"][0]["kind"], "canon_proposal");
    server.abort();
    s.finish().await
}
#[tokio::test]
async fn cp_08_stale_cas_rolls_back_every_operation_and_marks_draft() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, chat) = setup("CP-08", Access::AskAlways).await?;
    let epic = data(
        s.gw.post(
            &format!("/projects/{project}/canon/epics"),
            json!({"title":"기존 과제"}),
        )
        .await?,
        201,
    );
    let args = json!({"project_id":project,"summary":"관련 변경","changes":[{"op":"epic.create","title":"롤백 대상"},{"op":"epic.edit","id":epic["id"],"title":"수정 제안","expected_revision":epic["revision"]}]});
    let id = draft(&s, &script, &chat, args.clone()).await?;
    data(
        s.gw.patch(
            &format!("/canon/epics/{}", epic["id"].as_str().unwrap()),
            json!({"title":"보드에서 수정","expected_revision":epic["revision"]}),
        )
        .await?,
        200,
    );
    let result = accept(&s, &id).await?;
    assert_eq!(result["error"]["code"], "canon_conflict", "{result}");
    assert_eq!(read(&s, &id).await?["state"], "stale");
    let board = data(s.gw.get(&format!("/projects/{project}/canon")).await?, 200);
    assert_eq!(board["backlog"].as_array().unwrap().len(), 1);
    assert_eq!(board["backlog"][0]["title"], "보드에서 수정");
    data(
        s.gw.patch(
            &format!("/sessions/{chat}/controls"),
            json!({"access_mode":"auto"}),
        )
        .await?,
        200,
    );
    run(
        &s,
        &script,
        &chat,
        "최신 내용으로 반영해",
        vec![("canon_propose", args)],
    )
    .await?;
    let results = stub::results(&script);
    let refusal = results
        .iter()
        .rev()
        .find(|r| r["error"].is_object())
        .unwrap();
    assert_eq!(refusal["error"]["code"], "canon_conflict", "{refusal}");
    assert_eq!(
        refusal["error"]["message"],
        format!(
            "'보드에서 수정' changed before this was applied (now revision {}). Nothing was applied. Tell the user in one sentence; read it again before proposing.",
            board["backlog"][0]["revision"]
        )
    );
    let board = data(s.gw.get(&format!("/projects/{project}/canon")).await?, 200);
    assert_eq!(board["backlog"].as_array().unwrap().len(), 1);
    server.abort();
    s.finish().await
}
#[tokio::test]
async fn cp_09_existing_epic_binds_without_a_card_or_move() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, chat) = setup("CP-09", Access::AskAlways).await?;
    let epic = data(
        s.gw.post(
            &format!("/projects/{project}/canon/epics"),
            json!({"title":"기존 과제"}),
        )
        .await?,
        201,
    );
    run(
        &s,
        &script,
        &chat,
        "이 과제 이야기야",
        vec![(
            "canon_read",
            json!({"view":"epic","id":epic["id"],"bind":true}),
        )],
    )
    .await?;
    assert_eq!(asks(&s, &chat).await?["open_count"], 0);
    let current = data(
        s.gw.get(&format!("/canon/epics/{}", epic["id"].as_str().unwrap()))
            .await?,
        200,
    );
    assert_eq!(current["session_ids"], json!([chat]));
    assert_eq!(current["home_session_id"], Value::Null);
    assert_eq!(current["sessions"][0]["origin"], "butler");
    let home = data(
        s.gw.post(
            &format!("/canon/epics/{}/conversation", epic["id"].as_str().unwrap()),
            json!({}),
        )
        .await?,
        200,
    );
    assert_ne!(home["session_id"], chat);
    let chat_view = data(
        s.gw.get(&format!("/session-view?session_id={chat}"))
            .await?,
        200,
    );
    assert_eq!(chat_view["project_id"], Value::Null);
    let other = data(
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"다른 제품"}),
        )
        .await?,
        201,
    );
    let cross = data(
        s.gw.post(
            "/sessions",
            json!({"kind":"project","project_id":other["project"]["id"]}),
        )
        .await?,
        201,
    );
    let cross = cross["session"]["id"].as_str().unwrap();
    run(
        &s,
        &script,
        cross,
        "이 과제와 연결해",
        vec![(
            "canon_read",
            json!({"view":"epic","id":epic["id"],"bind":true}),
        )],
    )
    .await?;
    let view = data(
        s.gw.get(&format!("/session-view?session_id={cross}"))
            .await?,
        200,
    );
    assert_eq!(view["project_id"], other["project"]["id"]);
    server.abort();
    s.finish().await
}
#[tokio::test]
async fn cn_21_no_project_chat_card_defaults_to_most_recent_project() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, chat) = setup_with(
        Setup::new("CN-21")?.unset_env("BUTLER_E2E_APP_NOW"),
        Access::AskAlways,
    )
    .await?;
    let other = data(
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"다른 제품"}),
        )
        .await?,
        201,
    )["project"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let unscoped =
        |title: &str| json!({"summary":title,"changes":[{"op":"epic.create","title":title}]});
    let id = draft(&s, &script, &chat, unscoped("최근 프로젝트")).await?;
    assert_eq!(
        read(&s, &id).await?["project"],
        json!({"id":other,"name":"다른 제품"})
    );
    data(
        s.gw.patch(
            &format!("/projects/{project}"),
            json!({"display_name":"제품 앱"}),
        )
        .await?,
        200,
    );
    let message = "이 문제도 버그로 등록해 줘";
    run(
        &s,
        &script,
        &chat,
        message,
        vec![("canon_propose", unscoped("다시 고른 프로젝트"))],
    )
    .await?;
    let page = asks(&s, &chat).await?;
    let latest = page["asks"][0]["ask_id"]
        .as_str()
        .unwrap()
        .trim_start_matches("canon:")
        .to_owned();
    assert_ne!(latest, id);
    assert_eq!(
        read(&s, &latest).await?["project"],
        json!({"id":project,"name":"제품 앱"})
    );
    let result = accept(&s, &latest).await?;
    assert_eq!(result["ok"], true, "{result}");
    assert_bound(&s, &chat, &project, &epic_id(&result), "user").await?;
    server.abort();
    s.finish().await
}
