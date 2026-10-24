//! A committed canon save must reach the App before startup expires uploads.
use super::*;

mod requires_e2e_fixtures {
    use super::*;

    #[tokio::test]
    async fn at_13_save_kill_expire_startup_upload_keeps_files_and_relays_missing_references()
    -> Result<(), HarnessError> {
        butler_e2e::gate!();
        let mut s = Setup::new("AT-13")?
            .env("BUTLER_E2E_APP_NOW", "2026-10-24T10:00:00.000Z")
            .start()
            .await?;
        let project = project(&s).await?;
        let kept = attachments::upload(&s, &project).await?;
        let cancelled = attachments::upload(&s, &project).await?;
        let app_path = s.sandbox.data.join("app-server/butler-client.sqlite");
        // Hold the App side of the durable handoff at its pre-commit boundary.
        // Canon remains writable; the trigger is removed before the next launch.
        let db = rusqlite::Connection::open(&app_path)?;
        db.execute_batch("CREATE TRIGGER hold_attachment_relay BEFORE INSERT ON app_work_model_events BEGIN SELECT RAISE(ABORT,'relay interrupted'); END;")?;
        drop(db);
        let epic = data(s.gw.post(&format!("/projects/{project}/canon/epics"), json!({
            "title":"Saved before crash", "description":format!("![capture](attachment:{})", kept["file_id"].as_str().unwrap())
        })).await?, 201);
        assert_eq!(epic["attachments"][0]["file_id"], kept["file_id"]);
        s.agent.kill9()?;
        let db = rusqlite::Connection::open(&app_path)?;
        assert_eq!(
            db.query_row::<i64, _, _>(
                "SELECT count(*) FROM app_canon_epic_files WHERE epic_id=?1",
                [epic["id"].as_str()],
                |r| r.get(0)
            )?,
            0
        );
        db.execute_batch("DROP TRIGGER hold_attachment_relay")?;
        drop(db);
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let (payload, published): (String, i64) = db.query_row(
            "SELECT payload_json,published FROM canon_events WHERE json_extract(payload_json,'$.id')=?1 ORDER BY seq DESC LIMIT 1", [epic["id"].as_str()], |r| Ok((r.get(0)?,r.get(1)?)))?;
        assert_eq!(
            published, 0,
            "save is durable but has not crossed the App relay"
        );
        let mut missing: Value = serde_json::from_str(&payload)?;
        missing["id"] = json!("missing-historical-epic");
        missing["attachments"] = json!(["file-00000000-0000-4000-8000-000000000099"]);
        db.execute(
            "INSERT INTO canon_events(topic,payload_json,created_at) VALUES('canon.changed',?1,0)",
            [missing.to_string()],
        )?;
        drop(db);
        s.agent
            .launch
            .set_env("BUTLER_E2E_APP_NOW", "2026-10-25T10:00:01.000Z");
        let release = s.sandbox.data.join("canon-relay-release");
        s.agent
            .launch
            .set_env("BUTLER_E2E_HOLD_POINT", "canon_relay_start");
        s.agent
            .launch
            .set_env("BUTLER_E2E_HOLD_RELEASE", release.to_string_lossy());
        s.gw = s.agent.start_again().await?;
        attachment_contracts::wait_held(&release).await?;
        // No first drain can run until this upload has exercised the startup gate.
        let fresh = attachments::upload(&s, &project).await?;
        assert_eq!(s.gw.download(kept["url"].as_str().unwrap()).await?.0, 200);
        std::fs::write(&release, b"release")?;
        let stream = LiveEvents::subscribe(&s.gw, 0).await?;
        event(&stream, "canon.changed", epic["id"].as_str().unwrap()).await?;
        event(&stream, "canon.changed", "missing-historical-epic").await?;
        let tag = data(
            s.gw.post(
                &format!("/projects/{project}/canon/tags"),
                json!({"name":"After missing file","color":"blue"}),
            )
            .await?,
            201,
        );
        event(&stream, "canon.changed", tag["id"].as_str().unwrap()).await?;
        let loaded = data(
            s.gw.get(&format!("/canon/epics/{}", epic["id"].as_str().unwrap()))
                .await?,
            200,
        );
        assert_eq!(loaded["attachments"][0]["file_id"], kept["file_id"]);
        for file in [&kept, &fresh] {
            let (status, bytes) = s.gw.download(file["url"].as_str().unwrap()).await?;
            assert_eq!(status, 200);
            assert_eq!(bytes, butler_e2e::e2e::media::digits_png("57", 12));
        }
        assert_eq!(
            s.gw.get(cancelled["url"].as_str().unwrap()).await?.status,
            404
        );
        let db = rusqlite::Connection::open(&app_path)?;
        assert_eq!(
            db.query_row::<i64, _, _>(
                "SELECT count(*) FROM app_file_pending WHERE file_id=?1",
                [kept["file_id"].as_str()],
                |r| r.get(0)
            )?,
            0
        );
        assert_eq!(db.query_row::<i64, _, _>("SELECT count(*) FROM events WHERE type='stream.reconcile_required' AND created_at>='2026-10-25'", [], |r| r.get(0))?, 0);
        s.finish().await
    }
}
