use super::*;
async fn delegated(s: &Scenario, path: &str, title: &str) -> Result<(u16, Value), HarnessError> {
    let reply =
        s.gw.http()
            .get(format!("{}{path}", s.gw.base))
            .bearer_auth(&s.gw.token)
            .header("X-Butler-Delegate-Client", title)
            .header("X-Butler-Delegate-Client-Name", "connector_name")
            .send()
            .await?;
    Ok((reply.status().as_u16(), reply.json().await?))
}
#[tokio::test]
async fn cn_10_gateway_sanitizes_identity_and_keeps_allowed_capabilities_while_pending()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("CN-10-PERMISSIONS")?
        .data_folder_token()
        .start()
        .await?;
    let project = project(&s).await?;
    assert_eq!(delegated(&s, "/canon/list", "<b></b>").await?.0, 400);
    assert_eq!(
        delegated(&s, "/canon/list", "  <b>Connector</b>  ")
            .await?
            .0,
        403
    );
    let grant = pending(&s).await?;
    assert_eq!(grant["client_title"], "Connector");
    assert_eq!(grant["client_name"], "connector_name");
    assert_eq!(
        delegated(&s, "/canon/mcp-grants", "Connector").await?.1["error"]["code"],
        "permission"
    );
    let id = grant["id"].as_str().unwrap();
    decide(&s, id, "allow").await?;
    s.agent.terminate().await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.execute(
        "UPDATE canon_mcp_grants SET allowed_json='[\"canon.read\"]' WHERE id=?1",
        [id],
    )?;
    drop(db);
    s.restart().await?;
    let reply =
        s.gw.http()
            .post(format!("{}/projects/{project}/canon/epics", s.gw.base))
            .bearer_auth(&s.gw.token)
            .header("X-Butler-Delegate-Client", "Connector")
            .header("X-Butler-Delegate-Client-Name", "connector_name")
            .json(&json!({"title":"Needs creation grant"}))
            .send()
            .await?;
    assert_eq!(reply.status().as_u16(), 403);
    assert_eq!(
        reply.json::<Value>().await?["error"]["code"],
        "trust_pending"
    );
    let grant = pending(&s).await?;
    assert_eq!(grant["allowed"], json!(["canon.read"]));
    assert_eq!(grant["requested"].as_array().unwrap().len(), 5);
    assert_eq!(delegated(&s, "/canon/list", "Connector").await?.0, 200);
    read_while_writer_held(&s).await?;
    s.finish().await
}

#[tokio::test]
async fn cn_10_revoked_client_cannot_commit_a_write() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("CN-10-REVOKED-WRITE")?
        .data_folder_token()
        .start()
        .await?;
    let project = project(&s).await?;
    trust(&s).await?;
    let epic = call(
        &s,
        "canon_create_epic",
        json!({"project":project,"title":"Revocation check"}),
    )
    .await?;
    let grants = s.gw.get("/canon/mcp-grants").await?;
    let id = grants.data()["grants"][0]["id"].as_str().unwrap();
    decide(&s, id, "revoke").await?;
    let write = call(
        &s,
        "canon_update_epic_status",
        json!({"epic_id":epic["id"],"expected_revision":epic["revision"],"status":"in_progress"}),
    )
    .await?;
    assert_eq!(write["error"]["code"], "trust_pending");
    let current =
        s.gw.get(&format!("/canon/epics/{}", epic["id"].as_str().unwrap()))
            .await?;
    assert_eq!(current.data()["revision"], epic["revision"]);
    assert_eq!(current.data()["canon_status"], "planned");
    s.finish().await
}

async fn read_while_writer_held(s: &Scenario) -> Result<(), HarnessError> {
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let (locked, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let writer = tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
        let mut db = rusqlite::Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let _ = locked.send(());
        let _ = wait.recv();
        tx.rollback()?;
        Ok(())
    });
    ready
        .await
        .map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?;
    let read = tokio::time::timeout(
        Duration::from_secs(10),
        delegated(s, "/canon/list", "Connector"),
    )
    .await;
    let _ = release.send(());
    writer
        .await
        .map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))??;
    let reply = read.map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))??;
    assert_eq!(
        reply.0, 200,
        "Allowed reads must finish before the writer is released: {}",
        reply.1
    );
    assert_eq!(reply.1["data"]["epics"], json!([]));
    Ok(())
}

mod requires_e2e_fixtures {
    use super::*;
    #[tokio::test]
    async fn cn_10_revoke_between_admission_and_commit_refuses_the_write()
    -> Result<(), HarnessError> {
        butler_e2e::gate!();
        let setup = Setup::new("CN-10-REVOKE-RACE")?.data_folder_token();
        let release = setup.sandbox.data.join("canon-write-release");
        std::fs::write(&release, b"release")?;
        let s = setup
            .env("BUTLER_E2E_HOLD_POINT", "canon_write")
            .env("BUTLER_E2E_HOLD_RELEASE", release.to_string_lossy())
            .start()
            .await?;
        let project = project(&s).await?;
        trust(&s).await?;
        let epic = call(
            &s,
            "canon_create_epic",
            json!({"project":project,"title":"Admission race"}),
        )
        .await?;
        let grants = s.gw.get("/canon/mcp-grants").await?;
        let grant = grants.data()["grants"][0]["id"].as_str().unwrap();
        std::fs::remove_file(&release)?;
        std::fs::remove_file(release.with_extension("held"))?;
        let refused = {
            let write = call(
                &s,
                "canon_update_epic_status",
                json!({"epic_id":epic["id"],"expected_revision":epic["revision"],"status":"in_progress"}),
            );
            tokio::pin!(write);
            let held = tokio::time::timeout(Duration::from_secs(10), async {
                while !release.with_extension("held").exists() {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            });
            let early = tokio::select! {
                result = &mut write => Some(result?),
                result = held => { result.map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?; None },
            };
            assert!(
                early.is_none(),
                "write escaped the admission hold: {early:?}"
            );
            decide(&s, grant, "revoke").await?;
            std::fs::write(&release, b"release")?;
            write.await?
        };
        assert_eq!(refused["error"]["code"], "permission");
        let current =
            s.gw.get(&format!("/canon/epics/{}", epic["id"].as_str().unwrap()))
                .await?;
        assert_eq!(current.data()["revision"], epic["revision"]);
        assert_eq!(current.data()["canon_status"], "planned");
        s.finish().await
    }
}
