//! Exact browser values are reviewed on create/edit, even in tainted full access.
use super::super::{
    host::{admin, attach, snapshot, tab},
    tool::waiting_card,
};
use super::{
    URL,
    support::{ASK, begin, cassette, decide, delivered},
};
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Access, Setup},
};
use serde_json::{Value, json};
use std::sync::Arc;

#[tokio::test]
async fn model_created_schedule_reviews_both_values_including_defaults() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    for enabled in [false, true] {
        let mut args = json!({"id":"reviewed-schedule","title":"Account summary","prompt":"Read account", "schedule_type":"interval","interval_minutes":60});
        if enabled {
            args["browser_signin"] = json!(true);
            args["browser_payment"] = json!(true);
        }
        let script = cassette(vec![
            ("tool_describe", json!({"ids":["native:create_automation"]})),
            (
                "tool_call",
                json!({"id":"native:create_automation","arguments":args}),
            ),
        ])?;
        let s = Setup::new("SCHEDULE-CREATE-BROWSER-CARD")?
            .access(Access::AskExceptReads)
            .stub_cassette(script)
            .start()
            .await?;
        let turn = begin(&s, "general").await?;
        let card = waiting_card(&s, &turn).await?;
        assert_eq!(card["approval"]["schedule"]["browser_signin"], enabled);
        assert_eq!(card["approval"]["schedule"]["browser_payment"], enabled);
        assert_eq!(
            s.gw.get("/automations").await?.data()["automations"],
            json!([])
        );
        decide(&s, "general", &card, "once").await?;
        delivered(&s, "general", &turn).await?;
        let detail = s.gw.get("/automations/reviewed-schedule").await?;
        assert_eq!(detail.data()["automation"]["browser_signin"], enabled);
        assert_eq!(detail.data()["automation"]["browser_payment"], enabled);
        s.finish().await?;
    }
    Ok(())
}

#[tokio::test]
async fn tainted_full_access_schedule_edits_cannot_enable_browser_without_a_card()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    for field in ["browser_signin", "browser_payment"] {
        let mut args = json!({"id":"user-schedule"});
        args[field] = json!(true);
        let script = cassette(vec![
            (
                "tool_describe",
                json!({"ids":["native:browser_observe","native:update_automation"]}),
            ),
            (
                "tool_call",
                json!({"id":"native:browser_observe","arguments":{"tab":"plain"}}),
            ),
            (
                "tool_call",
                json!({"id":"native:update_automation","arguments":args}),
            ),
        ])?;
        let s = Setup::new("SCHEDULE-TAINTED-BROWSER-EDIT")?
            .access(Access::FullAccess)
            .stub_cassette(script)
            .start()
            .await?;
        let created = s.gw.post("/automations", json!({"id":"user-schedule","title":"Account summary","prompt_body":ASK,"target_session_id":"general","interval_seconds":3600})).await?;
        assert_eq!(created.status, 201, "{}", created.text);
        let admin = admin(&s);
        let _host = attach(&s, Arc::new(|_frame: Value| Box::pin(async move {
            json!({"status":"ok","tab":"plain","url":URL,"obs":"o1","text":"Outside page content"})
        }))).await?;
        let mut plain = tab("plain", "conversation:general", URL, "agent");
        plain["profile"] = json!("signed_out");
        snapshot(&admin, json!([plain])).await?;
        let turn = begin(&s, "general").await?;
        let card = waiting_card(&s, &turn).await?;
        assert_eq!(card["reason"], "authority.taintReason");
        assert_eq!(card["approval"]["schedule"][field], true);
        let other = if field == "browser_signin" {
            "browser_payment"
        } else {
            "browser_signin"
        };
        assert!(
            card["approval"]["schedule"].get(other).is_none(),
            "only changed fields: {card}"
        );
        let before = s.gw.get("/automations/user-schedule").await?;
        assert_eq!(
            before.data()["automation"][field],
            false,
            "outside content cannot mutate it before review"
        );
        decide(&s, "general", &card, "once").await?;
        delivered(&s, "general", &turn).await?;
        let after = s.gw.get("/automations/user-schedule").await?;
        assert_eq!(after.data()["automation"][field], true);
        assert_eq!(after.data()["automation"][other], false);
        s.finish().await?;
    }
    Ok(())
}

#[tokio::test]
async fn connector_tainted_full_access_schedule_create_requires_a_card() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let script = cassette(vec![
        (
            "tool_describe",
            json!({"ids":["mcp:e2e:e2e_echo","native:create_automation"]}),
        ),
        ("tool_call", json!({"id":"mcp:e2e:e2e_echo","arguments":{}})),
        (
            "tool_call",
            json!({"id":"native:create_automation","arguments":{
            "id":"tainted-create","title":"Account summary","prompt":"Read account",
            "schedule_type":"interval","interval_minutes":60,"browser_signin":true}}),
        ),
    ])?;
    let s = Setup::new("SCHEDULE-TAINTED-BROWSER-CREATE")?
        .access(Access::FullAccess)
        .stub_cassette(script)
        .start()
        .await?;
    let added =
        s.gw.post(
            "/mcp-servers",
            json!({"id":"e2e","display_name":"E2E connector",
        "enabled":true,"transport":"stdio","command":butler_e2e::e2e::binary::mcp_fixture_binary()?,
        "args":[],"env":[{"key":"E2E_MCP_NONCE","source":"literal","value":"connector-content"}]}),
        )
        .await?;
    assert_eq!(added.status, 201, "{}", added.text);
    let turn = begin(&s, "general").await?;
    let card = waiting_card(&s, &turn).await?;
    assert_eq!(card["reason"], "authority.taintReason");
    assert_eq!(card["approval"]["schedule"]["browser_signin"], true);
    assert_eq!(
        s.gw.get("/automations").await?.data()["automations"],
        json!([])
    );
    decide(&s, "general", &card, "once").await?;
    delivered(&s, "general", &turn).await?;
    assert_eq!(
        s.gw.get("/automations/tainted-create").await?.data()["automation"]["browser_signin"],
        true
    );
    s.finish().await
}
