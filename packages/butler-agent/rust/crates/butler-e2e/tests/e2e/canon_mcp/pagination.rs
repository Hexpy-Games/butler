use super::*;
use butler_canon::store;
#[tokio::test]
async fn cn_11_pages_are_complete_and_activity_cursor_has_no_gaps() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("CN-11-PAGES")?
        .data_folder_token()
        .start()
        .await?;
    let project = project(&s).await?;
    trust(&s).await?;
    s.agent.terminate().await?;
    let mut db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let tx = store::Transaction::new(db.transaction()?).map_err(|error| store_error(&error))?;
    let ctx = store::Context {
        now: 1,
        actor: json!({"person":"app-user","via":"app"}),
    };
    for n in 0..205 {
        store::create_work(
            &tx,
            &ctx,
            &store::NewWork {
                id: format!("epic-{n:03}"),
                project_id: project.clone(),
                title: if n == 0 {
                    "Epic 0 ".repeat(100)
                } else {
                    format!("Epic {n}")
                },
                description: String::new(),
                origin: butler_canon::work_types::Origin::Dialog,
            },
            &store::Registration::Canon(store::UserAct::new("app-user")),
        )
        .map_err(|error| store_error(&error))?;
    }
    store::set_label(
        &tx,
        &store::Context {
            now: 2,
            ..ctx.clone()
        },
        "epic-000",
        0,
        butler_canon::work_types::CanonStatus::InProgress,
        &store::UserAct::new("app-user"),
    )
    .map_err(|error| store_error(&error))?;
    for n in 0..55 {
        store::activity::append(
            &tx,
            &ctx,
            "epic-000",
            "comment",
            &format!("Comment {n}"),
            Some("Full body"),
        )
        .map_err(|error| store_error(&error))?;
    }
    for n in 0..60 {
        let private = store::Context {
            now: 2,
            actor: json!({"person":"app-user","via":"butler","origin":"chat"}),
        };
        store::activity::append(
            &tx,
            &private,
            "epic-000",
            "proposal_opened",
            &format!("Private {n}"),
            None,
        )
        .map_err(|e| store_error(&e))?;
    }
    tx.commit()?;
    drop(db);
    s.restart().await?;
    let started = std::time::Instant::now();
    let mut cursor = Value::Null;
    let mut ids = Vec::new();
    loop {
        let mut args = json!({"project":project});
        if !cursor.is_null() {
            args["cursor"] = cursor;
        }
        let page = call(&s, "canon_list", args).await?;
        assert!(page["epics"].as_array().unwrap().len() <= 100);
        for item in page["epics"].as_array().unwrap() {
            let n = item["id"]
                .as_str()
                .unwrap()
                .trim_start_matches("epic-")
                .parse::<usize>()
                .unwrap();
            assert_eq!(
                item["title"],
                if n == 0 {
                    "Epic 0 ".repeat(100)
                } else {
                    format!("Epic {n}")
                }
            );
            assert_eq!(
                item["status"],
                if n == 0 { "in_progress" } else { "planned" }
            );
            assert_eq!(item["revision"], i64::from(n == 0));
            assert_eq!(item["updated_at"], if n == 0 { 2 } else { 1 });
            assert_eq!(item["tags"], json!([]));
            assert!(item["assignee"].is_null());
            assert!(item["plan"].is_null());
            let mut keys = item
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>();
            keys.sort_unstable();
            assert_eq!(
                keys,
                vec![
                    "assignee",
                    "id",
                    "plan",
                    "revision",
                    "status",
                    "tags",
                    "title",
                    "updated_at"
                ]
            );
        }
        ids.extend(
            page["epics"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e["id"].as_str().unwrap().to_owned()),
        );
        cursor = page["cursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(
        ids,
        (0..205).map(|n| format!("epic-{n:03}")).collect::<Vec<_>>()
    );
    eprintln!(
        "CN-11 complete 205-epic stdio pagination: {:?}",
        started.elapsed()
    );
    let epic = call(&s, "canon_get_epic", json!({"epic_id":"epic-000"})).await?;
    let recent = epic["activity"].as_array().unwrap();
    assert_eq!(recent.len(), 50);
    let before = epic["activity_before"].as_i64().unwrap();
    assert_eq!(recent.last().unwrap()["seq"], before);
    let reply =
        s.gw.http()
            .get(format!(
                "{}/canon/epics/epic-000/activity?before={before}",
                s.gw.base
            ))
            .bearer_auth(&s.gw.token)
            .header("X-Butler-Delegate-Client", "Claude Code")
            .header("X-Butler-Delegate-Client-Name", "claude-code")
            .send()
            .await?;
    assert_eq!(reply.status().as_u16(), 200);
    let older_page: Value = reply.json().await?;
    let older = older_page["data"]["activity"].as_array().unwrap();
    assert_eq!(older.len(), 7);
    assert!(older.iter().all(|r| r["seq"].as_i64().unwrap() < before));
    assert!(older_page["data"]["activity_before"].is_null());
    let reply =
        s.gw.get(&format!("/canon/epics/epic-000/activity?before={before}"))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let older = reply.data()["activity"].as_array().unwrap();
    assert_eq!(older.len(), 7);
    assert!(older.iter().all(|r| r["seq"].as_i64().unwrap() < before));
    assert!(reply.data()["activity_before"].is_null());
    s.finish().await
}

#[tokio::test]
async fn cn_11_unscoped_list_excludes_archived_projects() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("CN-11-ARCHIVED")?
        .data_folder_token()
        .start()
        .await?;
    let project = project(&s).await?;
    trust(&s).await?;
    let epic = call(
        &s,
        "canon_create_epic",
        json!({"project":project,"title":"Archived epic"}),
    )
    .await?;
    let plan =
        s.gw.post(
            &format!("/projects/{project}/canon/plans"),
            json!({"title":"Archived plan"}),
        )
        .await?;
    assert_eq!(plan.status, 201);
    assert_eq!(
        s.gw.post(&format!("/projects/{project}/archive"), json!({}))
            .await?
            .status,
        200
    );
    let page = call(&s, "canon_list", json!({})).await?;
    assert_eq!(page["epics"], json!([]), "{epic}");
    assert_eq!(page["plans"], json!([]));
    s.finish().await
}
