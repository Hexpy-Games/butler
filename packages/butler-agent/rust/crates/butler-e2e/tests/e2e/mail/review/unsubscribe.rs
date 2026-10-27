use super::*;
#[tokio::test]
async fn review_host_unsubscribe_card_contains_exact_target_and_rejects_mismatch()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeImap::start().await?;
    let setup = setup("MAIL-UNSUBSCRIBE")?;
    let root = package(&setup.sandbox.home)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    let account = connect(&s, &fake, "password").await?;
    let url = "https://lists.example.test/leave?subscription=exact";
    let uid = fake.deliver("INBOX", &rfc822("unsubscribe", "List", "owner@example.test", "Body", &format!("List-Unsubscribe: <{url}>, <mailto:leave@example.test>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n")));
    let event = json!({"id":id("INBOX",1,uid)});
    let direct = Direct::open(&s, &fake, &account, "password").await?;
    let mismatch = direct
        .call(
            "unsubscribe",
            json!({"event_id":event["id"],"url":"https://other.example.test/leave"}),
        )
        .await?;
    assert!(
        mismatch
            .to_string()
            .contains("mail_unsubscribe_target_mismatch"),
        "{mismatch}"
    );
    for args in [
        json!({"event_id":event["id"]}),
        json!({"event_id":event["id"],"url":url,"mailto":"mailto:leave@example.test"}),
        json!({"event_id":event["id"],"mailto":"mailto:other@example.test"}),
    ] {
        let refused = direct.call("unsubscribe", args).await?;
        assert!(
            refused
                .to_string()
                .contains("mail_unsubscribe_target_mismatch")
        );
    }
    let mailto = direct
        .call(
            "unsubscribe",
            json!({"event_id":event["id"],"mailto":"mailto:leave@example.test"}),
        )
        .await?;
    assert_ne!(mailto["isError"], true, "{mailto}");
    let turn = card(&s, "unsubscribe", json!({"event_id":event["id"],"url":url})).await?;
    approve(&s, "deny").await?;
    s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
        .await?;
    direct.close("password").await?;
    s.finish().await
}
