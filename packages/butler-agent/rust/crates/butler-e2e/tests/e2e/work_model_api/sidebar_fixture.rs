use super::*;
#[tokio::test]
async fn wma_sidebar_seeded_visibility_and_plan_order() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Seed {
        s,
        project: project_id,
        chat,
    } = seeded(
        "WMA-SIDEBAR-FIXTURE",
        "UPDATE wm_works SET assignee='app-user' WHERE id='wk_passkey';",
    )
    .await?;
    assert_eq!(
        s.gw.post("/canon/epics/wk_minutes/conversation", json!({}))
            .await?
            .status,
        404
    );
    let linked = data(
        s.gw.post("/canon/epics/wk_canon/conversation", json!({}))
            .await?,
        200,
    );
    assert_eq!(linked["session_id"], chat);
    let navigation = data(s.gw.get("/navigation").await?, 200);
    assert!(navigation["chats"].to_string().contains(&chat));
    assert!(
        !navigation["space"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["entityId"] == chat || n["entity_id"] == chat)
    );
    create_plan(&s, &project_id, "Another plan").await?;
    let before = overview(&s, &project_id).await?;
    let view = data(
        s.gw.get(&format!("/projects/{project_id}/canon/sidebar"))
            .await?,
        200,
    );
    assert_eq!(view["groups"][0]["key"], "backlog");
    assert_eq!(ids(&view["groups"][0]["rows"]), vec!["wk_passkey"]);
    assert_eq!(view["groups"][1]["key"], "pl_p14");
    let group_keys: Vec<_> = view["groups"]
        .as_array()
        .unwrap()
        .iter()
        .skip(1)
        .map(|g| g["key"].clone())
        .collect();
    let plan_keys: Vec<_> = before["plans"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].clone())
        .collect();
    assert_eq!(group_keys, plan_keys);
    assert_eq!(
        view["groups"][1]["plan_revision"],
        before["plans"][0]["revision"]
    );
    assert_eq!(
        ids(&view["groups"][1]["rows"]),
        ids(&before["plans"][0]["works"])
    );
    assert_eq!(
        view["groups"][1]["rows"][0]["home_session_id"],
        before["plans"][0]["works"][0]["home_session_id"]
    );
    let path = format!("/projects/{project_id}/canon/sidebar-order");
    let mut order = ids(&view["groups"][1]["rows"]);
    order.reverse();
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    let changed = data(
        s.gw.post(&path, json!({"group_key":"pl_p14","work_ids":order}))
            .await?,
        200,
    );
    assert_eq!(ids(&changed["groups"][1]["rows"]), order);
    event(&stream, "canon.changed", "pl_p14").await?;
    // Concurrent replacements each return a complete order from their App transaction.
    let forward = ids(&before["plans"][0]["works"]);
    let (a, b) = tokio::join!(
        s.gw.post(&path, json!({"group_key":"pl_p14","work_ids":forward})),
        s.gw.post(&path, json!({"group_key":"pl_p14","work_ids":order}))
    );
    assert_eq!(ids(&data(a?, 200)["groups"][1]["rows"]), forward);
    assert_eq!(ids(&data(b?, 200)["groups"][1]["rows"]), order);
    assert_eq!(overview(&s, &project_id).await?, before);
    assert_eq!(
        s.gw.post(
            &path,
            json!({"group_key":"pl_p14","work_ids":["wk_passkey"]})
        )
        .await?
        .status,
        400
    );
    let another = project(&s).await?;
    assert_eq!(
        s.gw.post(
            &format!("/projects/{another}/canon/sidebar-order"),
            json!({"group_key":"pl_p14","work_ids":order})
        )
        .await?
        .status,
        400
    );
    s.finish().await
}
