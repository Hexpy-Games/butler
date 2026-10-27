use super::*;

#[tokio::test]
async fn external_web_result_requires_draft_in_auto_and_guards_chat_acceptance()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, chat) = setup("CP-taint", Access::Auto).await?;
    let path = s.sandbox.data.join("butler.config.json");
    let mut config: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    config["webSearch"] =
        json!({"provider":"mock","readerBackend":"disabled","planning":{"enabled":false}});
    std::fs::write(path, serde_json::to_vec(&config)?)?;
    run(
        &s,
        &script,
        &chat,
        "외부 결과를 읽고 등록해",
        vec![
            ("web_search", json!({"query":"release notes"})),
            ("canon_propose", proposal(&project, "외부에서 발견한 오류")),
        ],
    )
    .await?;
    assert!(
        stub::results(&script)
            .iter()
            .any(|r| r["ok"] == true && r["results"].is_array()),
        "web result must execute"
    );
    let page = asks(&s, &chat).await?;
    assert_eq!(page["open_count"], 1, "{page}");
    let id = page["asks"][0]["ask_id"]
        .as_str()
        .unwrap()
        .trim_start_matches("canon:");
    assert_eq!(read(&s, id).await?["state"], "open");
    let board = data(s.gw.get(&format!("/projects/{project}/canon")).await?, 200);
    assert_eq!(board["backlog"], json!([]));
    run(
        &s,
        &script,
        &chat,
        "외부 결과를 읽고 응 등록해",
        vec![
            ("web_search", json!({"query":"release notes"})),
            (
                "resolve_ask",
                json!({"ask_id":format!("canon:{id}"),"outcome":"accepted","quote":"응 등록해"}),
            ),
        ],
    )
    .await?;
    assert!(
        stub::results(&script)
            .iter()
            .any(|r| r["error"]["code"] == "untrusted_context")
    );
    assert_eq!(read(&s, id).await?["state"], "open");
    assert_eq!(accept(&s, id).await?["ok"], true);
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn invalid_project_returns_model_error_without_a_draft() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, chat) = setup("CP-project-invalid", Access::AskAlways).await?;
    data(
        s.gw.post(&format!("/projects/{project}/archive"), json!({}))
            .await?,
        200,
    );
    for id in ["missing-project", project.as_str()] {
        run(
            &s,
            &script,
            &chat,
            &format!("{id}에 등록해"),
            vec![("canon_propose", proposal(id, "오류"))],
        )
        .await?;
        let results = stub::results(&script);
        let error = results
            .iter()
            .rev()
            .find(|r| r["error"]["code"] == "canon_project_not_found")
            .expect("model-visible project error");
        assert_eq!(
            error["error"]["message"],
            format!(
                "Project {id} doesn't exist or is archived. Call canon_read (view projects) to pick one, or omit project_id to use this conversation's project."
            )
        );
        assert_eq!(asks(&s, &chat).await?["open_count"], 0);
    }
    let db = butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM canon_proposals", [], |r| r
            .get::<_, i64>(0))?,
        0
    );
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn project_chat_card_names_requested_project_and_move_destination_in_ui_language()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, _) = setup("CP-destination", Access::AskAlways).await?;
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
    let chat = data(
        s.gw.post(
            "/sessions",
            json!({"title":"프로젝트 대화","kind":"project","project_id":project}),
        )
        .await?,
        201,
    )["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let id = draft(&s, &script, &chat, proposal(&other, "다른 제품 오류")).await?;
    run(
        &s,
        &script,
        &chat,
        "등록 전 확인",
        vec![("canon_read", json!({"view":"canon","project_id":project}))],
    )
    .await?;
    let definitions = script
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter_map(|request| {
            butler_e2e::e2e::chatgpt_wire::tools(request)
                .find(|tool| tool["name"] == "resolve_ask")
                .cloned()
        })
        .collect::<Vec<_>>();
    assert_ne!(definitions, [] as [serde_json::Value; 0]);
    assert!(
        definitions
            .iter()
            .all(|definition| definition == &definitions[0]),
        "resolve_ask must be byte-stable across turns"
    );
    assert_eq!(
        definitions[0]["parameters"]["properties"]["outcome"]["enum"],
        json!(["answered", "dropped", "accepted", "declined"])
    );
    assert_eq!(
        read(&s, &id).await?["project"],
        json!({"id":other,"name":"다른 제품"})
    );
    let result = accept(&s, &id).await?;
    let epic = epic_id(&result);
    let row = data(s.gw.get(&format!("/canon/epics/{epic}")).await?, 200);
    let plan = data(
        s.gw.post(
            &format!("/projects/{other}/canon/plans"),
            json!({"title":"다음 계획"}),
        )
        .await?,
        201,
    );
    let id = draft(&s, &script, &chat, json!({"project_id":other,"summary":"모델 요약","changes":[{"op":"epic.move","id":epic,"expected_revision":row["revision"],"plan_id":plan["id"]}]})).await?;
    let card = read(&s, &id).await?;
    assert_eq!(card["changes"][0]["destination_plan_title"], "다음 계획");
    assert!(
        card["changes"][0]
            .get("current_plan_title")
            .unwrap()
            .is_null()
    );
    assert_eq!(card["epics"][0]["title"], "다른 제품 오류");
    data(
        s.gw.patch("/settings", json!({"language":"ko"})).await?,
        200,
    );
    assert_eq!(
        read(&s, &id).await?["target_label"],
        "‘다음 계획’으로 과제 이동"
    );
    assert_eq!(
        asks(&s, &chat).await?["asks"][0]["target_label"],
        "‘다음 계획’으로 과제 이동"
    );
    data(
        s.gw.patch("/settings", json!({"language":"en"})).await?,
        200,
    );
    assert_eq!(
        read(&s, &id).await?["target_label"],
        "Move Epic to ‘다음 계획’"
    );
    assert_eq!(
        asks(&s, &chat).await?["asks"][0]["target_label"],
        "Move Epic to ‘다음 계획’"
    );
    accept(&s, &id).await?;
    let row = data(s.gw.get(&format!("/canon/epics/{epic}")).await?, 200);
    let id = draft(&s, &script, &chat, json!({"project_id":other,"summary":"백로그로 이동","changes":[{"op":"epic.move","id":epic,"expected_revision":row["revision"],"plan_id":null}]})).await?;
    let card = read(&s, &id).await?;
    assert_eq!(card["changes"][0]["current_plan_title"], "다음 계획");
    assert!(card["changes"][0]["destination_plan_title"].is_null());
    assert_eq!(card["epics"][0]["title"], "다른 제품 오류");
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn resolve_ask_rejects_outcomes_for_the_other_ask_kind() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, chat) = setup("CP-outcomes", Access::AskAlways).await?;
    let id = draft(&s, &script, &chat, proposal(&project, "입력 확인")).await?;
    for (ask, outcome, answer) in [
        (format!("canon:{id}"), "answered", Some("登録")),
        (format!("canon:{id}"), "dropped", None),
        ("question:unknown".into(), "accepted", None),
        ("question:unknown".into(), "declined", None),
    ] {
        let message = format!("確認 {outcome}");
        let mut args = json!({"ask_id":ask,"outcome":outcome,"quote":message});
        if let Some(answer) = answer {
            args["answer"] = json!(answer);
        }
        run(&s, &script, &chat, &message, vec![("resolve_ask", args)]).await?;
        assert_eq!(
            stub::results(&script).last().unwrap()["error"]["code"],
            "invalid_outcome"
        );
        assert_eq!(read(&s, &id).await?["state"], "open");
    }
    server.abort();
    s.finish().await
}
