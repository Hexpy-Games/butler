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
    s.finish().await
}
