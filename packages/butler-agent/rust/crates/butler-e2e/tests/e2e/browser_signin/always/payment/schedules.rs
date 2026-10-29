//! Saved-card fills and purchase clicks require the switch and purchase-site allow.
use super::super::super::{
    host::{admin, attach, snapshot},
    vault::{CARD, CHECKOUT, Cleanup, tab, vault_scenario},
};
use super::super::schedules::{attention, create, run};
use butler_e2e::e2e::HarnessError;
use reqwest::Method;
use serde_json::{Value, json};
use std::sync::Arc;

#[tokio::test]
async fn payment_switch_gates_fills_and_final_clicks_for_all_schedule_runs()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = vault_scenario("SCHEDULE-PAYMENT-SWITCH", Some(super::script()?)).await?;
    let admin = admin(&s);
    let card = admin
        .send(
            Method::POST,
            "/security/vault/cards",
            Some(json!({"nickname":"Schedule card",
        "number":CARD,"exp_month":12,"exp_year":2030})),
            &[],
        )
        .await?;
    assert_eq!(card.status, 200, "{}", card.text);
    let id = card.data()["id"].as_str().unwrap();
    let mut cleanup = Cleanup::new(&admin);
    cleanup.track("cards", id);
    let allowed = admin
        .send(
            Method::POST,
            &format!("/security/vault/cards/{id}/sites"),
            Some(json!({"site":super::SITE,"allow":true})),
            &[],
        )
        .await?;
    assert_eq!(allowed.status, 200, "{}", allowed.text);
    let host = attach(&s, Arc::new(|frame: Value| Box::pin(async move {
        match frame["op"].as_str() {
            Some("pay.inspect") => json!({"status":"ok","url":CHECKOUT,"top_origin":super::TOP,
                "merchant_origin":super::TOP,"frame_origins":[super::TOP],"fields":["number"],"amount":"59,800원"}),
            Some("pay.fill") => json!({"status":"filled","url":CHECKOUT,"filled":["number"],"missing":[]}),
            Some("tab.prepare") => json!({"status":"ok","tab":"t1","url":CHECKOUT,"profile":"signed_out","obs":"o1",
                "steps":[{"action":"click","payment":true,"submit":true,"form_post":true,"hit":{"role":"button","name":"Pay","frame":""}}]}),
            _ => json!({"status":"ok","url":CHECKOUT,"steps":[{"status":"ok"}]}),
        }
    }))).await?;
    snapshot(&admin, json!([tab("t1", "agent", CHECKOUT)])).await?;
    for scheduled in [false, true] {
        for (on, purchase, code) in [
            (false, true, Some("schedule_payment_off")),
            (true, true, None),
            (true, false, Some("schedule_permission_required")),
        ] {
            let response = admin
                .send(
                    Method::POST,
                    "/security/vault/purchase-sites",
                    Some(json!({"site":super::SITE,"allow":purchase})),
                    &[],
                )
                .await?;
            assert_eq!(response.status, 200, "{}", response.text);
            let before = host.ops();
            let audits_before = audits(&s)?;
            let id = create(&s, scheduled, false, on).await?;
            let result = run(&s, &id, scheduled).await?;
            attention(&s, &result, code).await?;
            let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
            let output: String = db.query_row("SELECT result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='browser_act'", [result["turn_id"].as_str().unwrap()], |row| row.get(0))?;
            let output: Value = serde_json::from_str(&output)?;
            assert_eq!(
                output["steps"].as_array().map(Vec::len),
                Some(1),
                "every requested step gets a receipt: {output}"
            );
            drop(db);
            let after = host.ops();
            let added = &after[before.len()..];
            assert_eq!(
                added.iter().filter(|op| *op == "pay.fill").count(),
                usize::from(code.is_none())
            );
            assert_eq!(
                added.iter().filter(|op| *op == "tab.act").count(),
                usize::from(code.is_none())
            );
            assert_eq!(audits(&s)? - audits_before, i64::from(code.is_none()));
        }
    }
    drop(cleanup);
    s.finish().await
}

fn audits(s: &butler_e2e::e2e::scenario::Scenario) -> Result<i64, HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    Ok(db.query_row(
        "SELECT COUNT(*) FROM browser_vault_audit WHERE kind='card'",
        [],
        |row| row.get(0),
    )?)
}
