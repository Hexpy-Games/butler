use super::*;
use butler_e2e::e2e::scenario::Access;

#[tokio::test]
async fn review_full_access_connector_event_skips_outward_action_unattended()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    unattended(Access::FullAccess).await
}
#[tokio::test]
async fn review_auto_connector_event_skips_outward_action_unattended() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    unattended(Access::Auto).await
}
async fn unattended(access: Access) -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PC-ORIGIN-UNATTENDED")?.access(access);
    let root = package(&setup.sandbox.home, false)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    let id = connect(&s, "immediate", 10.0).await?;
    account(&s, &id, "connected").await?;
    s.provider()?.set_chat_responder(stub::send);
    emit(&s, &id, vec![event("injected")]).await?;
    count(
        &s,
        "SELECT count(*) FROM app_connector_deliveries WHERE admitted_at IS NOT NULL",
        1,
    )
    .await?;
    count(
        &s,
        "SELECT count(*) FROM turns WHERE state IN ('delivered','failed','cancelled')",
        1,
    )
    .await?;
    assert!(
        !data(&s).join(format!("{id}-calls")).exists(),
        "unattended connector turn executed outward action"
    );
    assert_eq!(
        s.gw.approval_requests("general").await?,
        Vec::<Value>::new()
    );
    assert!(
        s.provider()?
            .requests()
            .iter()
            .any(|r| r.to_string().contains("schedule_permission_required")),
        "missing unattended approval feedback"
    );
    s.finish().await
}
#[tokio::test]
async fn review_attended_origin_requires_card_and_user_full_access_still_executes()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    for access in [Access::FullAccess, Access::Auto] {
        let setup = setup("PC-ORIGIN-ATTENDED")?.access(access);
        let root = package(&setup.sandbox.home, false)?;
        let s = setup.start().await?;
        install(&s, &root).await?;
        let id = connect(&s, "immediate", 10.0).await?;
        account(&s, &id, "connected").await?;
        s.provider()?.set_chat_responder(stub::send);
        // Persist a delivery, then admit it attended through the normal queue.
        let connection =
            rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
        connection.execute("INSERT INTO app_connector_deliveries(id,account,payload,created_at,admitted_at) VALUES('attended-event',?1,'{}',0,'done')", [&id])?;
        drop(connection);
        let accepted = s.gw.send_message(json!({"chat_id":"general","text":"External event body","client_message_id":"attended-event"})).await?;
        let turn = s.gw.accepted_turn(&accepted).await?;
        let waited =
            s.gw.wait_turn(
                "general",
                &turn,
                &["waiting_for_form", "failed", "delivered"],
                Duration::from_secs(30),
            )
            .await?;
        assert_eq!(waited["state"], "waiting_for_form", "{waited}");
        let cards = serde_json::to_string(&s.gw.approval_requests("general").await?)?;
        assert!(
            cards.contains("mcp:source/events/send") && cards.contains("recipient@example.test"),
            "{cards}"
        );
        assert!(!data(&s).join(format!("{id}-calls")).exists());
        s.finish().await?;
    }
    let setup = setup("PC-ORIGIN-USER")?.access(Access::FullAccess);
    let root = package(&setup.sandbox.home, false)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    let id = connect(&s, "immediate", 10.0).await?;
    account(&s, &id, "connected").await?;
    s.provider()?.set_chat_responder(stub::send);
    let (_, turn) = s.turn("general", "Send the item").await?;
    assert_eq!(turn["state"], "delivered");
    assert!(data(&s).join(format!("{id}-calls")).exists());
    assert_eq!(
        s.gw.approval_requests("general").await?,
        Vec::<Value>::new()
    );
    s.finish().await
}
