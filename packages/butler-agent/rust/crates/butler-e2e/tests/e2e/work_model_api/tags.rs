use super::*;

async fn create_tag(s: &Scenario, project: &str, name: &str) -> Result<Value, HarnessError> {
    Ok(data(
        s.gw.post(
            &format!("/projects/{project}/canon/tags"),
            json!({"name":name,"color":"blue"}),
        )
        .await?,
        201,
    ))
}
async fn assign(s: &Scenario, epic: &Value, tags: Value) -> Result<Value, HarnessError> {
    Ok(data(
        s.gw.patch(
            &format!("/canon/epics/{}", epic["id"].as_str().unwrap()),
            json!({"expected_revision":epic["revision"],"tags":tags}),
        )
        .await?,
        200,
    ))
}
#[tokio::test]
async fn tg_01_create_and_assign_shows_tag_on_card() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("TG-01")?.start().await?;
    let project = project(&s).await?;
    let epic = create_epic(&s, &project, "과제").await?;
    let tag = create_tag(&s, &project, "  Feature  ").await?;
    let edited = assign(&s, &epic, json!([tag["id"]])).await?;
    let expected = json!([{ "id":tag["id"],"name":"Feature","color":"blue" }]);
    assert_eq!(edited["tags"], expected);
    assert_eq!(
        overview(&s, &project).await?["backlog"][0]["tags"],
        expected
    );
    let list = data(
        s.gw.get(&format!("/projects/{project}/canon/tags")).await?,
        200,
    );
    assert_eq!(list, json!([tag.clone()]));
    let alpha = create_tag(&s, &project, "alpha").await?;
    let ordered = assign(&s, &edited, json!([tag["id"], alpha["id"], tag["id"]])).await?;
    let expected = json!([
        {"id":alpha["id"],"name":"alpha","color":"blue"},
        {"id":tag["id"],"name":"Feature","color":"blue"}
    ]);
    assert_eq!(ordered["tags"], expected);
    assert_eq!(
        overview(&s, &project).await?["backlog"][0]["tags"],
        expected
    );
    s.finish().await
}
#[tokio::test]
async fn tg_02_add_remove_revision_events_and_conflicts() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("TG-02")?.start().await?;
    let project = project(&s).await?;
    let epic = create_epic(&s, &project, "과제").await?;
    let tag = create_tag(&s, &project, "Bug").await?;
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    let added = assign(&s, &epic, json!([tag["id"]])).await?;
    let removed = assign(&s, &added, json!([])).await?;
    assert_eq!(
        added["revision"].as_i64().unwrap(),
        epic["revision"].as_i64().unwrap() + 1
    );
    assert_eq!(
        removed["revision"].as_i64().unwrap(),
        added["revision"].as_i64().unwrap() + 1
    );
    assert_eq!(removed["tags"], json!([]));
    for row in [&added, &removed] {
        stream
            .wait_for(Duration::from_secs(10), |e| {
                e["type"] == "canon.changed"
                    && e["payload"]["id"] == row["id"]
                    && e["payload"]["revision"] == row["revision"]
            })
            .await?;
    }
    let other_project = super::project(&s).await?;
    let other = create_tag(&s, &other_project, "Other").await?;
    let path = format!("/canon/epics/{}", epic["id"].as_str().unwrap());
    for tags in [json!(["missing"]), json!([other["id"]])] {
        let rejected =
            s.gw.patch(
                &path,
                json!({"expected_revision":removed["revision"],"title":"rollback","tags":tags}),
            )
            .await?;
        assert_eq!(rejected.status, 409);
        assert_eq!(rejected.error_code(), Some("conflict"));
        assert_eq!(
            rejected.body["error"]["current"]["revision"],
            removed["revision"]
        );
        assert_eq!(data(s.gw.get(&path).await?, 200), removed);
    }
    drop(stream);
    s.finish().await
}
#[tokio::test]
async fn tg_03_duplicate_and_rename_return_existing_tag() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("TG-03")?.start().await?;
    let project = project(&s).await?;
    let existing = create_tag(&s, &project, "bug").await?;
    let duplicate =
        s.gw.post(
            &format!("/projects/{project}/canon/tags"),
            json!({"name":"Bug","color":"red"}),
        )
        .await?;
    assert_eq!(duplicate.status, 409);
    assert_eq!(duplicate.error_code(), Some("tag_exists"));
    assert_eq!(duplicate.body["error"]["existing"], existing);
    let second = create_tag(&s, &project, "Work").await?;
    let path = format!("/canon/tags/{}", second["id"].as_str().unwrap());
    let collision =
        s.gw.patch(&path, json!({"expected_revision":0,"name":"BUG"}))
            .await?;
    assert_eq!(collision.status, 409);
    assert_eq!(collision.body["error"]["existing"], existing);
    let changed = data(
        s.gw.patch(
            &path,
            json!({"expected_revision":0,"name":"Alpha","color":"teal"}),
        )
        .await?,
        200,
    );
    assert_eq!(changed["revision"], 1);
    assert_eq!(changed["color"], "teal");
    assert_eq!(
        s.gw.patch(&path, json!({"expected_revision":0,"color":"red"}))
            .await?
            .status,
        409
    );
    let list = data(
        s.gw.get(&format!("/projects/{project}/canon/tags")).await?,
        200,
    );
    assert_eq!(list, json!([changed.clone(), existing]));
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    stream
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "canon.changed"
                && e["payload"]["kind"] == "tag"
                && e["payload"]["id"] == changed["id"]
                && e["payload"]["revision"] == 1
        })
        .await?;
    drop(stream);
    for (name, color) in [
        ("", "blue"),
        ("   ", "red"),
        ("ok", "#fff"),
        ("ok", "amber"),
    ] {
        assert_eq!(
            s.gw.post(
                &format!("/projects/{project}/canon/tags"),
                json!({"name":name,"color":color})
            )
            .await?
            .status,
            400
        );
    }
    assert_eq!(
        s.gw.post(
            &format!("/projects/{project}/canon/tags"),
            json!({"name":"한".repeat(33),"color":"blue"})
        )
        .await?
        .status,
        400
    );
    let unicode = create_tag(&s, &project, &"한".repeat(32)).await?;
    assert_eq!(unicode["name"], "한".repeat(32));
    let accent = create_tag(&s, &project, "É").await?;
    let duplicate =
        s.gw.post(
            &format!("/projects/{project}/canon/tags"),
            json!({"name":"e\u{301}","color":"gray"}),
        )
        .await?;
    assert_eq!(duplicate.status, 409);
    assert_eq!(duplicate.body["error"]["existing"], accent);
    s.finish().await
}
#[tokio::test]
async fn tg_04_delete_cascades_without_epic_revision_changes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("TG-04")?.start().await?;
    let project = project(&s).await?;
    let tag = create_tag(&s, &project, "Shared").await?;
    let mut epics = Vec::new();
    for title in ["One", "Two", "Three"] {
        let epic = create_epic(&s, &project, title).await?;
        epics.push(assign(&s, &epic, json!([tag["id"]])).await?);
    }
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    let last = epics.last().unwrap();
    let marker = stream
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "canon.changed"
                && e["payload"]["id"] == last["id"]
                && e["payload"]["revision"] == last["revision"]
        })
        .await?;
    let deleted =
        s.gw.delete(&format!("/canon/tags/{}", tag["id"].as_str().unwrap()))
            .await?;
    assert_eq!(deleted.status, 200);
    for epic in epics {
        let after = data(
            s.gw.get(&format!("/canon/epics/{}", epic["id"].as_str().unwrap()))
                .await?,
            200,
        );
        assert_eq!(after["tags"], json!([]));
        assert_eq!(after["revision"], epic["revision"]);
        stream
            .wait_for(Duration::from_secs(10), |e| {
                e["type"] == "canon.changed"
                    && e["payload"]["id"] == epic["id"]
                    && e["id"].as_u64() > marker["id"].as_u64()
                    && e["payload"]["revision"] == epic["revision"]
            })
            .await?;
        let rejected =
            s.gw.patch(
                &format!("/canon/epics/{}", epic["id"].as_str().unwrap()),
                json!({"expected_revision":epic["revision"],"tags":[tag["id"]]}),
            )
            .await?;
        assert_eq!(rejected.status, 409);
    }
    stream
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "canon.changed"
                && e["payload"]["id"] == tag["id"]
                && e["id"].as_u64() > marker["id"].as_u64()
        })
        .await?;
    assert_eq!(
        data(
            s.gw.get(&format!("/projects/{project}/canon/tags")).await?,
            200
        ),
        json!([])
    );
    assert!(
        overview(&s, &project).await?["backlog"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["tags"] == json!([]))
    );
    drop(stream);
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
        let db = rusqlite::Connection::open(path)?;
        for table in [
            "canon_tags",
            "canon_epic_tags",
            "btcc_guided_works",
            "canon_epic_work_links",
        ] {
            assert_eq!(
                db.query_row::<i64, _, _>(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get(0))?,
                0
            );
        }
        assert_eq!(
            db.query_row::<i64, _, _>(
                "SELECT count(*) FROM canon_audit WHERE entity_kind='tag' AND op='delete'",
                [],
                |r| r.get(0)
            )?,
            1
        );
        assert_eq!(
            db.query_row::<i64, _, _>(
                "SELECT count(*) FROM canon_audit WHERE entity_kind='work' AND op='tag_delete'",
                [],
                |r| r.get(0)
            )?,
            3
        );
        Ok(())
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))??;
    s.finish().await
}

#[tokio::test]
async fn tg_05_creation_with_tags_preserves_create_ordering() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("TG-05")?.start().await?;
    let project = project(&s).await?;
    let tag = create_tag(&s, &project, "Feature").await?;
    let other_project = super::project(&s).await?;
    let other = create_tag(&s, &other_project, "Other").await?;
    let deleted = create_tag(&s, &project, "Deleted").await?;
    assert_eq!(
        s.gw.delete(&format!("/canon/tags/{}", deleted["id"].as_str().unwrap()))
            .await?
            .status,
        200
    );
    let path = format!("/projects/{project}/canon/epics");
    for invalid in [json!("missing"), other["id"].clone(), deleted["id"].clone()] {
        let rejected =
            s.gw.post(
                &path,
                json!({"title":"Rejected","tags":[tag["id"],invalid]}),
            )
            .await?;
        assert_eq!(rejected.status, 400);
        assert_eq!(rejected.error_code(), Some("work_model_invalid"));
        assert_eq!(overview(&s, &project).await?["backlog"], json!([]));
    }
    let epic = data(
        s.gw.post(&path, json!({"title":"과제","tags":[tag["id"]]}))
            .await?,
        201,
    );
    assert_eq!(epic["revision"], 1);
    let expected = json!([{ "id":tag["id"],"name":"Feature","color":"blue" }]);
    assert_eq!(epic["tags"], expected);
    assert_eq!(
        overview(&s, &project).await?["backlog"][0]["tags"],
        expected
    );
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    let created = event(&stream, "canon.changed", epic["id"].as_str().unwrap()).await?;
    assert_eq!(created["payload"]["revision"], 0);
    assert_eq!(created["payload"]["tags"], expected);
    drop(stream);
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
        let db = rusqlite::Connection::open(path)?;
        assert_eq!(
            db.query_row::<i64, _, _>("SELECT count(*) FROM canon_epics", [], |r| r.get(0))?,
            1
        );
        assert_eq!(
            db.query_row::<i64, _, _>(
                "SELECT count(*) FROM canon_audit WHERE entity_kind='work'",
                [],
                |r| r.get(0)
            )?,
            2
        );
        let mut stmt =
            db.prepare("SELECT payload_json FROM canon_events WHERE topic='canon.changed'")?;
        let events = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .map(|r| serde_json::from_str::<Value>(&r.unwrap()).unwrap())
            .filter(|e| e["kind"] == "work" || e["kind"] == "backlog")
            .collect::<Vec<_>>();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["id"], epic["id"]);
        assert_eq!(events[0]["tags"], expected);
        assert_eq!(events[0]["revision"], 0);
        assert_eq!(events[1]["id"], epic["id"]);
        assert_eq!(events[1]["revision"], 1);
        assert_eq!(events[2]["kind"], "backlog");
        assert_eq!(events[2]["id"], project);
        assert_eq!(events[2]["revision"], 1);
        Ok(())
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))??;
    s.finish().await
}
