use super::*;
#[tokio::test]
async fn related_plan_epic_move_edit_and_reorder_use_the_board_cas_writers()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, chat) = setup("CP-operations", Access::Auto).await?;
    run(&s,&script,&chat,"새 계획을 등록해",vec![("canon_propose",json!({"project_id":project,"summary":"계획 등록","changes":[{"op":"plan.create","title":"다음 릴리스"}]}))]).await?;
    let board = data(s.gw.get(&format!("/projects/{project}/canon")).await?, 200);
    let plan = &board["plans"][0];
    let plan_id = plan["id"].as_str().unwrap();
    let epic = data(
        s.gw.post(
            &format!("/projects/{project}/canon/epics"),
            json!({"title":"기존 오류"}),
        )
        .await?,
        201,
    );
    let id = epic["id"].as_str().unwrap();
    run(&s,&script,&chat,"계획과 과제를 함께 바꿔",vec![("canon_propose",json!({"project_id":project,"summary":"관련 변경","changes":[
        {"op":"plan.edit","id":plan_id,"expected_revision":plan["revision"],"title":"정식 릴리스","due_on":"2027-01-31"},
        {"op":"epic.edit","id":id,"expected_revision":epic["revision"],"title":"수정한 오류","tags":[{"new":{"name":"확인","color":"blue"}}]},
    ]}))]).await?;
    let epic = data(s.gw.get(&format!("/canon/epics/{id}")).await?, 200);
    assert_eq!(epic["title"], "수정한 오류");
    assert_eq!(epic["tags"][0]["name"], "확인");
    run(&s,&script,&chat,"계획으로 옮겨",vec![("canon_propose",json!({"project_id":project,"summary":"과제 이동","changes":[{"op":"epic.move","id":id,"expected_revision":epic["revision"],"plan_id":plan_id}]}))]).await?;
    let plan = data(s.gw.get(&format!("/canon/plans/{plan_id}")).await?, 200);
    assert_eq!(plan["title"], "정식 릴리스");
    assert_eq!(plan["due_on"], "2027-01-31");
    assert_eq!(plan["works"][0]["id"], id);
    run(&s,&script,&chat,"순서를 반영해",vec![("canon_propose",json!({"project_id":project,"summary":"순서 반영","changes":[{"op":"plan.reorder","id":plan_id,"expected_revision":plan["revision"],"work_ids":[id]}]}))]).await?;
    let plan = data(s.gw.get(&format!("/canon/plans/{plan_id}")).await?, 200);
    assert_eq!(plan["works"].as_array().unwrap().len(), 1);
    assert_eq!(plan["works"][0]["id"], id);
    assert!(
        !stub::results(&script).iter().any(|r| r["ok"] == false),
        "{:?}",
        stub::results(&script)
    );
    server.abort();
    s.finish().await
}
#[tokio::test]
async fn spec_read_and_atomic_edit_preserve_full_body_and_criteria() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server, project, chat) = setup("CP-spec", Access::AskAlways).await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let scope = project.clone();
    tokio::task::spawn_blocking(move || -> Result<(),HarnessError> {
        let db=butler_platform::sqlite::open(path)?;
        db.execute("INSERT INTO canon_spec_nodes(node_id,scope_kind,scope_ref,concern_id,visibility,lifecycle,source,revision,created_at,updated_at,created_by) VALUES('spec-flow','project',?1,'사용성','canon','draft','local',0,0,0,'{}')",[scope])?;
        Ok(())
    }).await.map_err(|e|HarnessError(e.to_string()))??;
    s.gw = s.agent.start_again().await?;
    run(
        &s,
        &script,
        &chat,
        "프로젝트의 명세를 찾아",
        vec![("canon_read", json!({"view":"canon","project_id":project}))],
    )
    .await?;
    let shared = stub::results(&script)
        .into_iter()
        .find(|r| r["untrusted_content"]["specs"].is_array())
        .unwrap();
    assert_eq!(
        shared["untrusted_content"]["specs"][0]["node_id"],
        "spec-flow"
    );
    assert_eq!(shared["untrusted_content"]["specs"][0]["revision"], 0);
    let body = "# 사용성\n\n- [ ] 저장한 내용을 다시 열 수 있다.";
    let id=draft(&s,&script,&chat,json!({"project_id":project,"summary":"명세 반영","changes":[{"op":"spec.edit","id":"spec-flow","expected_revision":0,"body":body,"criteria":[{"id":"keep","part_id":"usability","text":"저장한 내용을 다시 열 수 있다."}]}]})).await?;
    accept(&s, &id).await?;
    run(
        &s,
        &script,
        &chat,
        "명세를 다시 읽어",
        vec![("canon_read", json!({"view":"spec","id":"spec-flow"}))],
    )
    .await?;
    let result = stub::results(&script)
        .into_iter()
        .find(|r| r["untrusted_content"]["node_id"] == "spec-flow")
        .unwrap();
    assert_eq!(result["untrusted_content"]["body"], body);
    assert_eq!(result["untrusted_content"]["revision"], 2);
    assert_eq!(
        result["untrusted_content"]["criteria"],
        json!([{"node_id":"spec-flow","revision":1,"criterion_id":"keep","part_id":"usability","text":"저장한 내용을 다시 열 수 있다."}])
    );
    let revised = format!("{body}\n\n편집한 설명을 모두 유지한다.");
    let id=draft(&s,&script,&chat,json!({"project_id":project,"summary":"명세 설명 수정","changes":[{"op":"spec.edit","id":"spec-flow","expected_revision":2,"body":revised}]})).await?;
    accept(&s, &id).await?;
    run(
        &s,
        &script,
        &chat,
        "명세를 확인해",
        vec![("canon_read", json!({"view":"spec","id":"spec-flow"}))],
    )
    .await?;
    let latest = stub::results(&script)
        .into_iter()
        .rev()
        .find(|r| r["untrusted_content"]["node_id"] == "spec-flow")
        .unwrap();
    assert_eq!(latest["untrusted_content"]["body"], revised);
    assert_eq!(latest["untrusted_content"]["revision"], 4);
    assert_eq!(latest["untrusted_content"]["active_revision"], 2);
    assert_eq!(
        latest["untrusted_content"]["criteria"],
        json!([{"node_id":"spec-flow","revision":2,"criterion_id":"keep","part_id":"usability","text":"저장한 내용을 다시 열 수 있다."}])
    );
    server.abort();
    s.finish().await
}
