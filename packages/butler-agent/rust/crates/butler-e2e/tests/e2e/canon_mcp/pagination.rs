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
    let tx = store::Transaction::new(db.transaction()?).map_err(store_error)?;
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
                title: format!("Epic {n}"),
                description: String::new(),
                origin: butler_canon::work_types::Origin::Dialog,
            },
            &store::Registration::Canon(store::UserAct::new("app-user")),
        )
        .map_err(store_error)?;
    }
    for n in 0..55 {
        store::activity::append(
            &tx,
            &ctx,
            "epic-000",
            "comment",
            &format!("Comment {n}"),
            Some("Full body"),
        )
        .map_err(store_error)?;
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
        s.gw.get(&format!("/canon/epics/epic-000/activity?before={before}"))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let older = reply.data()["activity"].as_array().unwrap();
    assert_eq!(older.len(), 6);
    assert!(older.iter().all(|r| r["seq"].as_i64().unwrap() < before));
    assert!(reply.data()["activity_before"].is_null());
    s.finish().await
}
