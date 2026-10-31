use super::*;

#[tokio::test]
async fn wma_01_canon_create_move_order_and_events() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("WMA-01")?.start().await?;
    let project = project(&s).await?;
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    let plan = create_plan(&s, &project, "프리뷰 14").await?;
    let plan_id = plan["id"].as_str().unwrap();
    let canon_work = create_epic(&s, &project, "캐논").await?;
    let document_work = create_epic(&s, &project, "문서").await?;
    let image_work = create_epic(&s, &project, "이미지 도구").await?;
    let queue_work = create_epic(&s, &project, "작업 큐").await?;
    assert_eq!(canon_work["origin"], "dialog");
    assert!(canon_work["plan_id"].is_null());
    assert_eq!(
        serde_json::from_str::<Value>(canon_work["created_by"].as_str().unwrap()).unwrap()["person"],
        "app-user"
    );
    let a_id = canon_work["id"].as_str().unwrap();
    let b_id = document_work["id"].as_str().unwrap();
    let first = event(&stream, "canon.changed", a_id).await?;
    data(
        s.gw.patch(
            &format!("/canon/epics/{b_id}"),
            json!({"expected_revision":document_work["revision"],"plan_id":plan_id}),
        )
        .await?,
        200,
    );
    let moved = data(
        s.gw.patch(
            &format!("/canon/epics/{a_id}"),
            json!({"expected_revision":canon_work["revision"],"plan_id":plan_id,"before_id":b_id}),
        )
        .await?,
        200,
    );
    let page = data(s.gw.get(&format!("/canon/plans/{plan_id}")).await?, 200);
    assert_eq!(ids(&page["works"]), vec![a_id, b_id]);
    assert_eq!(page["progress"], json!({"total":2,"done":0}));
    let ordered = data(
        s.gw.post(
            &format!("/canon/plans/{plan_id}/order"),
            json!({"work_ids":[b_id,a_id],"expected_revision":page["revision"]}),
        )
        .await?,
        200,
    );
    assert_eq!(ids(&ordered["works"]), vec![b_id, a_id]);
    assert!(ordered["revision"].as_i64() > page["revision"].as_i64());
    let before = overview(&s, &project).await?;
    let backlog = data(
        s.gw.post(
            &format!("/projects/{project}/canon/backlog/order"),
            json!({"work_ids":[queue_work["id"],image_work["id"]],"expected_revision":before["backlog_revision"]}),
        )
        .await?,
        200,
    );
    assert_eq!(
        ids(&backlog["backlog"]),
        vec![
            queue_work["id"].as_str().unwrap(),
            image_work["id"].as_str().unwrap()
        ]
    );
    let stale =
        s.gw.post(
            &format!("/projects/{project}/canon/backlog/order"),
            json!({"work_ids":[image_work["id"],queue_work["id"]],"expected_revision":before["backlog_revision"]}),
        )
        .await?;
    assert_eq!(stale.status, 409);
    assert_eq!(
        stale.body["error"]["current"]["revision"],
        backlog["backlog_revision"]
    );
    let latest = overview(&s, &project).await?;
    assert_eq!(latest, backlog);
    assert_eq!(latest["plans"].as_array().unwrap().len(), 1);
    assert_eq!(ids(&latest["plans"][0]["works"]), vec![b_id, a_id]);
    let changed = stream
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "canon.changed"
                && e["payload"]["id"] == a_id
                && e["payload"]["revision"] == moved["revision"]
        })
        .await?;
    assert!(changed["payload"]["revision"].as_i64() > first["payload"]["revision"].as_i64());
    assert!(changed["id"].as_u64() > first["id"].as_u64());
    assert_eq!(changed["payload"]["event_seq"], changed["id"]);
    assert_eq!(changed["payload"]["project_id"], project);
    assert_eq!(changed["payload"]["origin"], "local");
    let reconnect = LiveEvents::subscribe(&s.gw, first["id"].as_u64().unwrap()).await?;
    assert_eq!(
        reconnect
            .wait_for(Duration::from_secs(5), |e| e["id"] == changed["id"])
            .await?,
        changed
    );
    drop(reconnect);
    drop(stream);
    s.finish().await
}

#[tokio::test]
async fn wma_02_stale_epic_edit_returns_winning_revision() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("WMA-02")?.start().await?;
    let project = project(&s).await?;
    let work = create_epic(&s, &project, "문서").await?;
    let path = format!("/canon/epics/{}", work["id"].as_str().unwrap());
    let winner = data(
        s.gw.patch(
            &path,
            json!({"expected_revision":work["revision"],"title":"명세 문서"}),
        )
        .await?,
        200,
    );
    let stale =
        s.gw.patch(
            &path,
            json!({"expected_revision":work["revision"],"title":"이전 편집"}),
        )
        .await?;
    assert_eq!(stale.status, 409);
    assert_eq!(stale.error_code(), Some("conflict"));
    assert_eq!(
        stale.body["error"]["current"]["revision"],
        winner["revision"]
    );
    assert_eq!(data(s.gw.get(&path).await?, 200), winner);
    assert_eq!(winner["title"], "명세 문서");
    assert_eq!(winner["tasks"], json!([]));
    assert_eq!(winner["specs"], json!([]));
    let actor =
        s.gw.patch(
            &path,
            json!({"expected_revision":winner["revision"],"actor":"forged","title":"forged"}),
        )
        .await?;
    assert_eq!(actor.status, 400);
    assert_eq!(data(s.gw.get(&path).await?, 200), winner);
    let missing = s.gw.get("/projects/missing/canon").await?;
    assert_eq!(missing.status, 404);
    assert_eq!(missing.error_code(), Some("project_not_found"));
    s.finish().await
}

#[tokio::test]
async fn cn_01_dialog_epic_needs_a_title_and_lands_in_backlog_and_sidebar()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("CN-01")?.start().await?;
    let project = project(&s).await?;
    let path = format!("/projects/{project}/canon/epics");
    for body in [json!({}), json!({"title":""}), json!({"title":"  \n"})] {
        let refused = s.gw.post(&path, body.clone()).await?;
        assert_eq!(refused.status, 400, "{body}: {}", refused.text);
    }
    assert_eq!(overview(&s, &project).await?["backlog"], json!([]));
    let created = data(
        s.gw.post(
            &path,
            json!({"title":"캐논","description":"계획과 과제","assignee":"app-user"}),
        )
        .await?,
        201,
    );
    let id = created["id"].as_str().unwrap();
    assert_eq!(created["origin"], "dialog");
    assert_eq!(created["canon_status"], "planned");
    assert_eq!(created["assignee"], "app-user");
    assert!(created["plan_id"].is_null());
    let board = overview(&s, &project).await?;
    assert_eq!(ids(&board["backlog"]), vec![id]);
    assert_eq!(board["backlog"][0]["title"], "캐논");
    let sidebar = data(
        s.gw.get(&format!("/projects/{project}/canon/sidebar"))
            .await?,
        200,
    );
    assert_eq!(sidebar["groups"][0]["kind"], "backlog");
    assert_eq!(ids(&sidebar["groups"][0]["rows"]), vec![id]);
    let detail = data(s.gw.get(&format!("/canon/epics/{id}")).await?, 200);
    assert_eq!(detail["title"], "캐논");
    assert_eq!(detail["description"], "계획과 과제");
    s.finish().await
}
