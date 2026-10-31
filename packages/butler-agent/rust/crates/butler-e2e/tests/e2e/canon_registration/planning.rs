//! Canon changes found while BTCC plans: 명세 refinement and mid-work registration.
use super::*;

fn pipeline(refs: Value) -> Vec<(&'static str, Value)> {
    let done = json!([{"action_key":"inspect","status":"done"}]);
    vec![
        (
            "replace_work_plan",
            json!({"objective":"과제 확인","execution_mode":"direct","governing_refs":refs,"actions":[{"action_key":"inspect","description":"과제 내용 확인"}],"checks":["명세 기준 충족"]}),
        ),
        (
            "record_work_review",
            json!({"subject":"plan","verdict":"accept","summary":"확인 범위 충족"}),
        ),
        (
            "record_work_checkpoint",
            json!({"action_updates":done,"public_summary":"내용 확인","next_step":"결과 검토"}),
        ),
        (
            "record_work_review",
            json!({"subject":"result","verdict":"accept","summary":"기준 충족"}),
        ),
        (
            "record_work_review",
            json!({"subject":"completion","verdict":"accept","summary":"검증 완료"}),
        ),
        (
            "record_work_disposition",
            json!({"work_id":"$work","disposition":"completed","summary":"확인 완료","action_updates":[],"remaining_actions":[],"followups":[]}),
        ),
    ]
}
fn accepted_plans(s: &Scenario) -> Result<Vec<(String, Value)>, HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let rows = db
        .prepare("SELECT json_extract(result_json,'$.work.work_id'),arguments_json FROM btcc_guided_tool_calls WHERE tool_name='replace_work_plan' AND status='completed' AND json_extract(result_json,'$.ok')=1 ORDER BY rowid")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(work, args)| Ok((work, serde_json::from_str(&args)?)))
        .collect()
}
fn links(s: &Scenario) -> Result<Vec<(String, String)>, HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let rows = db
        .prepare("SELECT epic_id,btcc_work_id FROM canon_epic_work_links ORDER BY linked_at")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[tokio::test]
async fn cb_05_confirmed_spec_revision_reaches_context_and_governing_refs()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server, project, chat) = setup("CB-05", Access::AskAlways).await?;
    let epic = data(
        s.gw.post(
            &format!("/projects/{project}/canon/epics"),
            json!({"title":"시각화 블록"}),
        )
        .await?,
        201,
    );
    let epic = epic["id"].as_str().unwrap().to_owned();
    s.agent.terminate().await?;
    let (path, scope, owner) = (
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        project.clone(),
        epic.clone(),
    );
    tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
        let db = butler_platform::sqlite::open(path)?;
        db.execute("INSERT INTO canon_spec_nodes(node_id,scope_kind,scope_ref,epic_id,concern_id,visibility,lifecycle,source,revision,created_at,updated_at,created_by) VALUES('spec-blocks','project',?1,?2,'시각화','canon','draft','local',0,0,0,'{}')",[scope,owner])?;
        Ok(())
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))??;
    s.gw = s.agent.start_again().await?;
    run(
        &s,
        &script,
        &chat,
        "이 과제 이야기야",
        vec![("canon_read", json!({"view":"epic","id":epic,"bind":true}))],
    )
    .await?;
    let body = "# 시각화\n\n- VB-01 1만 행을 끊김 없이 스크롤한다.";
    let id = draft(&s, &script, &chat, json!({"project_id":project,"summary":"명세 기준 추가","changes":[{"op":"spec.edit","id":"spec-blocks","expected_revision":0,"body":body,"criteria":[{"id":"VB-01","part_id":"scroll","text":"1만 행을 끊김 없이 스크롤한다."}]}]})).await?;
    assert_eq!(links(&s)?, Vec::new(), "the card itself starts no Work");
    accept(&s, &id).await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let active: i64 = db.query_row(
        "SELECT active_revision FROM canon_spec_nodes WHERE node_id='spec-blocks'",
        [],
        |r| r.get(0),
    )?;
    drop(db);
    let spec_ref = format!("canon:spec/spec-blocks@{active}");
    let message = "확정한 명세로 진행해";
    run(
        &s,
        &script,
        &chat,
        message,
        pipeline(json!([format!("canon:epic/{epic}"), spec_ref])),
    )
    .await?;
    let first = script
        .requests
        .lock()
        .unwrap()
        .iter()
        .find(|r| r.to_string().contains(message))
        .cloned()
        .unwrap()
        .to_string();
    assert!(
        first.contains("## Canon epics in this conversation"),
        "{first}"
    );
    assert!(first.contains(&spec_ref), "{first}");
    assert!(first.contains("1만 행을 끊김 없이 스크롤한다."));
    let plans = accepted_plans(&s)?;
    assert_eq!(plans.len(), 1, "{plans:?}");
    assert_eq!(
        plans[0].1["governing_refs"],
        json!([format!("canon:epic/{epic}"), spec_ref])
    );
    assert_eq!(links(&s)?, vec![(epic.clone(), plans[0].0.clone())]);
    let progress = data(
        s.gw.get(&format!("/canon/epics/{epic}/progress")).await?,
        200,
    );
    assert_eq!(progress["disposition"], "completed", "{progress}");
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn cn_15_registering_mid_work_links_the_running_work_in_place() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, chat) = setup("CN-15", Access::Auto).await?;
    let mut calls = pipeline(json!([]));
    let linked = pipeline(json!(["canon:epic/$epic"]));
    calls.truncate(2);
    calls.push(("canon_propose",json!({"project_id":project,"summary":"과제 등록","changes":[{"op":"epic.create","title":"언어 설정 멈춤","description":"설정 화면에서 언어를 바꾸면 앱이 멈춘다"}]})));
    calls.extend(linked);
    run(&s, &script, &chat, "이거 과제로 등록해 줘", calls).await?;
    let applied = stub::results(&script)
        .into_iter()
        .find(|r| r["state"] == "applied")
        .expect("registration applied");
    let epic = epic_id(&applied);
    assert_bound(&s, &chat, &project, &epic, "butler").await?;
    let plans = accepted_plans(&s)?;
    assert_eq!(plans.len(), 2, "{plans:?}");
    assert_eq!(plans[0].0, plans[1].0, "the same Work continues");
    assert_eq!(plans[0].1["governing_refs"], json!([]));
    assert_eq!(
        plans[1].1["governing_refs"],
        json!([format!("canon:epic/{epic}")])
    );
    assert_eq!(links(&s)?, vec![(epic.clone(), plans[0].0.clone())]);
    let epic_row = data(s.gw.get(&format!("/canon/epics/{epic}")).await?, 200);
    assert_ne!(epic_row["canon_status"], "planned", "{epic_row}");
    let progress = data(
        s.gw.get(&format!("/canon/epics/{epic}/progress")).await?,
        200,
    );
    assert_eq!(progress["disposition"], "completed", "{progress}");
    assert_eq!(progress["counts"], json!({"completed":1,"total":1}));
    server.abort();
    s.finish().await
}
