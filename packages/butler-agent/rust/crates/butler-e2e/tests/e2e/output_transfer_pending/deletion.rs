use super::*;

pub(super) fn collected(
    s: &Scenario,
    archive: &str,
    ids: &[&str],
    bodies: &[&[u8]],
) -> Result<(), HarnessError> {
    for table in ["outputs", "output_refs"] {
        let count: i64 = db(&s.sandbox.data)?.query_row(
            &format!("SELECT count(*) FROM {table} WHERE session=?1"),
            [archive],
            |r| r.get(0),
        )?;
        assert_eq!(count, 0, "{table} still names archive");
    }
    assert_eq!(count(s, "app_output_transfers")?, 0);
    assert_eq!(count(s, "app_session_delete_cleanups")?, 0);
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT count(*) FROM output_blobs")?,
        0
    );
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT count(*) FROM output_blob_sweep")?,
        0
    );
    assert!(!markers(&s.sandbox.data, archive).exists());
    for id in ids {
        assert!(!manifest(&s.sandbox.data, id).exists());
    }
    for body in bodies {
        let sha = hash(body);
        assert!(
            !s.sandbox
                .data
                .join("outputs/blobs")
                .join(&sha[..2])
                .join(sha)
                .exists()
        );
    }
    Ok(())
}
fn authority(s: &Scenario) -> Result<sqlite::Connection, HarnessError> {
    Ok(sqlite::open(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
    )?)
}
fn seed_authority(s: &Scenario, archive: &str) -> Result<(), HarnessError> {
    let hint: String = app(s)?.query_row(
        "SELECT runtime_session_hint FROM chats WHERE id=?1",
        [archive],
        |r| r.get(0),
    )?;
    authority(s)?.execute("INSERT INTO btcc_authority_requests(request_id,request_ref,identity_sha256,owner_session_id,source_session_id,source_turn_id,source_work_id,workspace_path,plan_revision_id,action_key,authority_generation,capability,normalized_target,normalized_input_json,model_ref,reasoning_effort,category,reason,executable,command_count,decision,allow_scope,schedule_client_message_id,schedule_input_text,outcome,created_at,updated_at)
      VALUES('retained','retained','retained',?1,?1,'retained','retained','','retained','retained',1,'run_command','retained','{}','custom/stub','low','command','retained','run_command',1,'pending','once','retained','','pending','2026-01-01','2026-01-01')", [hint])?;
    Ok(())
}
#[derive(Clone, Copy, Debug)]
enum Route {
    Permanent,
    Plain,
    Post,
    Patch,
    Project,
}
async fn request(
    s: &Scenario,
    archive: &str,
    route: Route,
) -> Result<butler_e2e::e2e::gateway::Reply, HarnessError> {
    let path = format!("/sessions/{archive}");
    match route {
        Route::Permanent => s.gw.delete(&format!("{path}?permanent=true")).await,
        Route::Plain => s.gw.delete(&path).await,
        Route::Post => s.gw.post(&format!("{path}/archive"), json!({})).await,
        Route::Patch => s.gw.patch(&path, json!({"archived":true})).await,
        Route::Project => {
            let project: String =
                app(s)?.query_row("SELECT project_id FROM chats WHERE id=?1", [archive], |r| {
                    r.get(0)
                })?;
            s.gw.delete(&format!("/projects/{project}?permanent=true"))
                .await
        }
    }
}
async fn refuses(route: Route) -> Result<(), HarnessError> {
    let setup = setup("TRANSFER-DELETE")?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    let (id, bytes, obstacle) = blocked(&mut s).await?;
    let archive = pending(&s)?;
    if matches!(route, Route::Project) {
        // Archived chats can be unarchived then relocated into a project.
        let r =
            s.gw.patch(&format!("/sessions/{archive}"), json!({"archived":false}))
                .await?;
        assert_eq!(r.status, 200, "{r:?}");
        butler_e2e::e2e::fixtures::default_project_folder(&s).await?;
        let r =
            s.gw.post(
                "/projects",
                json!({"source":"scratch","display_name":"Transfer"}),
            )
            .await?;
        assert_eq!(r.status, 201, "{r:?}");
        let project = r.data()["project"]["id"].as_str().unwrap().to_owned();
        let navigation = s.gw.get("/navigation").await?;
        let moved =
            s.gw.post(
                "/space/relocations",
                json!({
                    "operationId":"transfer-relocation", "sessionId":archive,
                    "expectedRevision":navigation.data()["space"]["revision"],
                    "targetKey":format!("p:{project}"), "position":"inside"
                }),
            )
            .await?;
        assert_eq!(moved.status, 200, "{moved:?}");
    }
    seed_authority(&s, &archive)?;
    let before: String = app(&s)?.query_row("SELECT json_array(id,title,archived,updated_at,runtime_session_hint,project_id) FROM chats WHERE id=?1", [&archive], |r| r.get(0))?;
    let r = request(&s, &archive, route).await?;
    assert_eq!(r.status, 409, "{route:?}: {r:?}");
    assert_eq!(r.body["error"]["code"], "output_transfer_pending", "{r:?}");
    assert_eq!(
        r.body["error"]["message"],
        "결과물을 옮기는 중입니다. 잠시 후 다시 시도해 주세요."
    );
    assert_pending(&s, &archive)?;
    let after: String = app(&s)?.query_row("SELECT json_array(id,title,archived,updated_at,runtime_session_hint,project_id) FROM chats WHERE id=?1", [&archive], |r| r.get(0))?;
    assert_eq!(after, before);
    assert_eq!(count(&s, "app_session_delete_cleanups")?, 0);
    assert_eq!(count(&s, "app_canon_session_deletes")?, 0);
    let closed: bool = authority(&s)?.query_row(
        "SELECT close_reason IS NOT NULL FROM btcc_authority_requests WHERE request_id='retained'",
        [],
        |r| r.get(0),
    )?;
    assert!(!closed, "refusal closed authority");
    assert!(manifest(&s.sandbox.data, &id).is_dir());
    assert_eq!(
        scalar(
            &s.sandbox.data,
            "SELECT count(*) FROM outputs WHERE session='general'"
        )?,
        1
    );
    let sha = hash(b"Retained output");
    assert!(
        s.sandbox
            .data
            .join("outputs/blobs")
            .join(&sha[..2])
            .join(sha)
            .is_file()
    );
    restore(&s, &id, bytes, obstacle)?;
    // Same request succeeds immediately, without a restart or a second user retry.
    let r = request(&s, &archive, route).await?;
    assert_eq!(r.status, 200, "{route:?}: {r:?}");
    assert_finished(&s)?;
    collected(&s, &archive, &[&id], &[b"Retained output"])?;
    let closed: bool = authority(&s)?.query_row(
        "SELECT close_reason IS NOT NULL FROM btcc_authority_requests WHERE request_id='retained'",
        [],
        |r| r.get(0),
    )?;
    assert!(closed);
    s.finish().await
}
#[tokio::test]
async fn permanent_delete_refuses_pending_before_any_mutation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    refuses(Route::Permanent).await
}
#[tokio::test]
async fn plain_delete_refuses_pending_before_any_mutation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    refuses(Route::Plain).await
}
#[tokio::test]
async fn post_archive_refuses_pending_before_any_mutation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    refuses(Route::Post).await
}
#[tokio::test]
async fn patch_archive_refuses_pending_before_any_mutation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    refuses(Route::Patch).await
}
#[tokio::test]
async fn project_delete_refuses_pending_before_any_mutation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    refuses(Route::Project).await
}
