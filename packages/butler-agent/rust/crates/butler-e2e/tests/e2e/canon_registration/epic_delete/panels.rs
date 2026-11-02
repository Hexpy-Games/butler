use super::*;

pub(super) async fn wait_settled(
    app: &rusqlite::Connection,
    source: &str,
) -> Result<(), HarnessError> {
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        let state: String = app.query_row("SELECT json_extract(payload_json,'$.panel.state') FROM app_initiated_messages WHERE source_key=?1", [source], |r|r.get(0))?;
        if state == "deleted" {
            return Ok(());
        }
        assert!(
            std::time::Instant::now() < deadline,
            "panel remains {state}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn epic_delete_settles_hold_and_take_panels_through_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, _, server, project, _) = setup("EPIC-DELETE-PANELS", Access::AskAlways).await?;
    let epic = create(&s, &project).await?;
    let id = epic["id"].as_str().unwrap();
    let home = data(
        s.gw.post(&format!("/canon/epics/{id}/conversation"), json!({}))
            .await?,
        200,
    )["session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let canon = db(&s)?;
    let owner: String = canon.query_row(
        "SELECT session_id FROM canon_session_epics WHERE epic_id=?1",
        [id],
        |r| r.get(0),
    )?;
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    for kind in ["canon_hold", "canon_take_here"] {
        let payload = json!({"session_id":owner,"other_session_id":owner,"epic_id":id,"epic_title":"삭제할 과제","state":"pending"});
        canon.execute("INSERT INTO canon_intents(op_id,kind,payload_json,state,created_at) VALUES(?1,?1,?2,'pending',0)", rusqlite::params![kind,payload.to_string()])?;
        app.execute("INSERT INTO app_initiated_messages(id,chat_id,kind,source_key,text,payload_json,state,created_at) VALUES(?1,?2,?1,?1,'Pending',?3,'posted','2026-01-01')", rusqlite::params![kind,home,json!({"panel":payload}).to_string()])?;
    }
    seed_past_panels(&canon, &app, &owner, &home, id)?;
    // Fail the terminal projection, then prove replay settles both existing cards.
    app.execute_batch("CREATE TRIGGER refuse_panel BEFORE UPDATE ON app_initiated_messages BEGIN SELECT RAISE(ABORT,'projection unavailable'); END;")?;
    assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 200);
    s.agent.kill9()?;
    app.execute_batch("DROP TRIGGER refuse_panel")?;
    s.gw = s.agent.start_again().await?;
    for kind in ["canon_hold", "canon_take_here"] {
        wait_settled(&app, kind).await?;
        assert_eq!(
            app.query_row::<i64, _, _>(
                "SELECT count(*) FROM app_initiated_messages WHERE source_key=?1",
                [kind],
                |r| r.get(0)
            )?,
            1
        );
    }
    assert_past_panels(&canon, &app).await?;
    drop(app);
    drop(canon);
    s.restart().await?;
    server.abort();
    s.finish().await
}

fn seed_past_panels(
    canon: &rusqlite::Connection,
    app: &rusqlite::Connection,
    owner: &str,
    home: &str,
    epic: &str,
) -> Result<(), HarnessError> {
    for (kind, state) in [("canon_hold", "continued"), ("canon_take_here", "taken")] {
        let source = format!("past-{kind}");
        let mut payload = json!({"session_id":owner,"other_session_id":owner,"epic_id":epic,"epic_title":"과거 결정","state":"pending"});
        canon.execute("INSERT INTO canon_intents(op_id,kind,payload_json,state,created_at) VALUES(?1,?2,?3,'applied',0)", rusqlite::params![source,kind,payload.to_string()])?;
        payload["state"] = json!(state);
        payload["source_key"] = json!(source);
        canon.execute("INSERT INTO canon_intents(op_id,kind,payload_json,state,created_at) VALUES(?1,?2,?3,'pending',0)", rusqlite::params![format!("{source}:answer"),kind,payload.to_string()])?;
        app.execute("INSERT INTO app_initiated_messages(id,chat_id,kind,source_key,text,payload_json,state,created_at) VALUES(?1,?2,?3,?1,'Past decision',?4,'posted','2026-01-01')", rusqlite::params![source,home,kind,json!({"panel":payload}).to_string()])?;
    }
    Ok(())
}

async fn assert_past_panels(
    canon: &rusqlite::Connection,
    app: &rusqlite::Connection,
) -> Result<(), HarnessError> {
    for (kind, expected) in [("canon_hold", "continued"), ("canon_take_here", "taken")] {
        let source = format!("past-{kind}");
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while canon.query_row::<String, _, _>(
            "SELECT state FROM canon_intents WHERE op_id=?1",
            [format!("{source}:epic-deleted")],
            |r| r.get(0),
        )? != "applied"
        {
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(app.query_row::<String,_,_>("SELECT json_extract(payload_json,'$.panel.state') FROM app_initiated_messages WHERE source_key=?1", [&source], |r|r.get(0))?, expected, "preserve {source}");
    }
    Ok(())
}

mod requires_e2e_fixtures {
    use super::*;
    #[tokio::test]
    async fn epic_delete_cannot_reopen_an_in_flight_hold_panel() -> Result<(), HarnessError> {
        butler_e2e::gate!();
        in_flight_panel(true).await
    }

    #[tokio::test]
    async fn epic_delete_first_in_flight_panel_has_terminal_text() -> Result<(), HarnessError> {
        butler_e2e::gate!();
        in_flight_panel(false).await
    }

    async fn in_flight_panel(settled: bool) -> Result<(), HarnessError> {
        let (mut s, _, server, project, _) =
            setup("EPIC-DELETE-PANEL-RACE", Access::AskAlways).await?;
        let epic = create(&s, &project).await?;
        let id = epic["id"].as_str().unwrap();
        let home = data(
            s.gw.post(&format!("/canon/epics/{id}/conversation"), json!({}))
                .await?,
            200,
        )["session_id"]
            .as_str()
            .unwrap()
            .to_owned();
        s.agent.terminate().await?;
        let release = s.sandbox.data.join("panel-release");
        s.agent
            .launch
            .set_env("BUTLER_E2E_HOLD_POINT", "canon_panel_projection");
        s.agent
            .launch
            .set_env("BUTLER_E2E_HOLD_RELEASE", release.to_string_lossy());
        let canon = db(&s)?;
        let owner: String = canon.query_row(
            "SELECT session_id FROM canon_session_epics WHERE epic_id=?1",
            [id],
            |r| r.get(0),
        )?;
        canon.execute("INSERT INTO canon_intents(op_id,kind,payload_json,state,created_at) VALUES('in-flight-panel','canon_hold',?1,'pending',0)", [json!({"session_id":owner,"epic_id":id,"epic_title":"삭제할 과제","state":"pending"}).to_string()])?;
        let app =
            butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
        app.execute_batch("CREATE TABLE panel_attempts(n INTEGER); CREATE TRIGGER observe_panel BEFORE INSERT ON app_initiated_messages WHEN NEW.source_key='in-flight-panel' BEGIN INSERT INTO panel_attempts VALUES(1); END;")?;
        s.gw = s.agent.start_again().await?;
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while !release.with_extension("held").exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "panel projection did not reach barrier"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 200);
        // Commit the terminal App projection while the earlier snapshot is paused.
        if settled {
            app.execute("INSERT INTO app_initiated_messages(id,chat_id,kind,source_key,text,payload_json,state,created_at) VALUES('settled-in-flight',?1,'canon_hold','in-flight-panel','Deleted',?2,'posted','2026-01-01')", rusqlite::params![home,json!({"panel":{"epic_id":id,"state":"deleted"}}).to_string()])?;
        }
        app.execute_batch("CREATE TABLE reopened_panels(n INTEGER); CREATE TRIGGER observe_reopen AFTER UPDATE OF payload_json ON app_initiated_messages WHEN NEW.source_key='in-flight-panel' AND json_extract(NEW.payload_json,'$.panel.state')='pending' BEGIN INSERT INTO reopened_panels VALUES(1); END;")?;
        std::fs::write(&release, b"continue")?;
        let app =
            butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while app.query_row::<i64, _, _>(
            "SELECT count(*) FROM app_initiated_messages WHERE source_key='in-flight-panel'",
            [],
            |r| r.get(0),
        )? == 0
        {
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        while app.query_row::<i64, _, _>("SELECT count(*) FROM panel_attempts", [], |r| r.get(0))?
            < 2
        {
            assert!(
                std::time::Instant::now() < deadline,
                "stale projection did not finish"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        if settled {
            assert_eq!(
                app.query_row::<i64, _, _>("SELECT count(*) FROM reopened_panels", [], |r| r
                    .get(0))?,
                0
            );
        }
        wait_settled(&app, "in-flight-panel").await?;
        let text: String = app.query_row(
            "SELECT text FROM app_initiated_messages WHERE source_key='in-flight-panel'",
            [],
            |r| r.get(0),
        )?;
        assert!(
            !text.contains("막혀") && !text.contains("blocked"),
            "{text}"
        );
        assert_eq!(
            app.query_row::<String, _, _>(
                "SELECT chat_id FROM app_initiated_messages WHERE source_key='in-flight-panel'",
                [],
                |r| r.get(0)
            )?,
            home
        );
        drop(app);
        drop(canon);
        s.restart().await?;
        server.abort();
        s.finish().await
    }
}
