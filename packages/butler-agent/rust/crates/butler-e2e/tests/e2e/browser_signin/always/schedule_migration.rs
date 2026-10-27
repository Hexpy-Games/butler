//! One-time capability migration: source/target grants survive; later grants
//! never turn switches on, and schedules created after upgrade default off.
use super::super::host::{admin, attach, call, snapshot, tab};
use super::{
    SITE, URL, observe,
    schedules::run,
    support::{ASK, session},
};
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::{Value, json};
use std::sync::Arc;

#[tokio::test]
async fn upgrade_preserves_existing_schedule_capability_once_and_new_defaults_stay_off()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SCHEDULE-BROWSER-UPGRADE")?
        .env("BUTLER_E2E_APP_NOW", "2026-09-27T12:00:00Z")
        .stub_cassette(observe()?)
        .start()
        .await?;
    let source = session(&s).await?;
    let empty = session(&s).await?;
    call(
        &admin(&s),
        &source,
        "signin.grant",
        "",
        json!({"site":SITE}),
    )
    .await?;
    for (id, target, creator) in [
        ("source-grant", "general", Some(source.as_str())),
        ("target-grant", source.as_str(), None),
        ("no-grant", empty.as_str(), None),
    ] {
        let created = s.gw.post("/automations", json!({"id":id,"title":id,"prompt_body":ASK,"target_session_id":target,"source_session_id":creator,"interval_seconds":3600})).await?;
        assert_eq!(created.status, 201, "{}", created.text);
    }
    s.agent.terminate().await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    db.execute_batch("ALTER TABLE app_automations DROP COLUMN browser_signin;
        ALTER TABLE app_automations DROP COLUMN browser_payment;
        DELETE FROM app_settings WHERE key='schedule_browser_options_v1';
        INSERT INTO browser_payment_cards(id,nickname,brand,last4,exp_month,exp_year,created_at)
          VALUES('legacy-card','Everyday','visa','5556',12,2030,'2026-01-01T00:00:00Z');
        INSERT INTO browser_vault_sites VALUES('card','legacy-card','fixture-shop.test','2026-01-01T00:00:00Z');
        INSERT INTO browser_purchase_sites VALUES('fixture-shop.test','2026-01-01T00:00:00Z');")?;
    drop(db);
    s.gw = s.agent.start_again().await?;
    for (id, signin) in [
        ("source-grant", true),
        ("target-grant", true),
        ("no-grant", false),
    ] {
        let detail = s.gw.get(&format!("/automations/{id}")).await?;
        assert_eq!(detail.data()["automation"]["browser_signin"], signin);
        assert_eq!(detail.data()["automation"]["browser_payment"], true);
    }
    let host = attach(
        &s,
        Arc::new(|_frame: Value| {
            Box::pin(async move {
                json!({"status":"ok","tab":"identity","url":URL,"obs":"o1","text":"Account"})
            })
        }),
    )
    .await?;
    snapshot(
        &admin(&s),
        json!([tab("identity", "conversation:general", URL, "agent")]),
    )
    .await?;
    let updated =
        s.gw.patch(
            "/automations/source-grant",
            json!({"schedule_type":"once","run_at":"2000-01-01T00:00:00Z"}),
        )
        .await?;
    assert_eq!(updated.status, 200, "{}", updated.text);
    let result = run(&s, "source-grant", true).await?;
    assert!(result["safe_error_code"].is_null(), "{result}");
    assert!(host.ops().iter().any(|op| op == "tab.observe"));
    drop(host);
    call(&admin(&s), &empty, "signin.grant", "", json!({"site":SITE})).await?;
    let new = s.gw.post("/automations", json!({"title":"After upgrade","prompt_body":ASK,"target_session_id":empty,"interval_seconds":3600})).await?;
    assert_eq!(new.status, 201, "{}", new.text);
    assert_eq!(new.data()["automation"]["browser_signin"], false);
    assert_eq!(new.data()["automation"]["browser_payment"], false);
    s.restart().await?;
    let unchanged = s.gw.get("/automations/no-grant").await?;
    assert_eq!(
        unchanged.data()["automation"]["browser_signin"],
        false,
        "migration never runs again"
    );
    s.finish().await
}
