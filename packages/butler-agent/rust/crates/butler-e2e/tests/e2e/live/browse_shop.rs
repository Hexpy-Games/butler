//! Paired offline-shop acceptance on the live-e2e environment's model only.
use super::*;
use crate::browse_executor::shop;
use butler_e2e::e2e::scenario::Access;
use reqwest::Method;

#[tokio::test]
#[ignore = "LIVE tier"]
async fn live_browse_shop_off_auto_five_each() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Some(provider) = live::gate("LIVE-BROWSE-SHOP")? else {
        return Ok(());
    };
    let mut successes = [0; 2];
    for (mode, setting) in ["off", "auto"].into_iter().enumerate() {
        for run in 1..=5 {
            live::spend_turn()?;
            let s = Setup::new("LIVE-BROWSE-SHOP")?
                .live(provider.clone())
                .access(Access::AskExceptReads)
                .env("BUTLER_BROWSER_HEADLESS", "on")
                .env("BUTLER_BROWSER_APP", "off")
                .env(
                    "BUTLER_BROWSER_CACHE_DIR",
                    crate::browser_headless::support::cache()
                        .display()
                        .to_string(),
                )
                .start()
                .await?;
            let reply =
                s.gw.patch("/settings", json!({"browser":{"browsing_agent":setting}}))
                    .await?;
            assert_eq!(reply.status, 200, "{}", reply.text);
            let url = shop::publish(&s).await?;
            let admin = crate::live::hedge_v2::preflight::admin(&s);
            let opened = crate::browser_headless::support::open(&admin, "general", &url).await?;
            assert_eq!(
                opened["status"], "ok",
                "offline fixture browser must be ready"
            );
            let prompt = format!(
                "At {url}, compare the two products and add the cheaper one to the cart. Continue to checkout and request approval to place the order, showing the exact action. Do not approve or place the order."
            );
            let id = accepted_turn_id(&s.gw.say("general", &prompt).await?)?;
            let turn =
                s.gw.wait_turn(
                    "general",
                    &id,
                    &["waiting_for_form", "delivered", "failed"],
                    Duration::from_secs(300),
                )
                .await?;
            let success = verify(&s, &turn).await?;
            successes[mode] += usize::from(success);
            let usage = s.gw.get("/session-view?session_id=general").await?;
            let usage = &usage.data()["usage"];
            let rounds = rounds(&s, &id)?;
            let record = json!({"setting":setting,"run":run,"success":success,"rounds":rounds,
                "executor_requests":usage["by_role"]["browse"]["request_count"].as_u64().unwrap_or(0),
                "input_tokens":usage["input_tokens"],"output_tokens":usage["output_tokens"],
                "list_price_cost":usage["cost"]});
            live::report("LIVE-BROWSE-SHOP", &record.to_string());
            assert!(usage["input_tokens"].as_u64().is_some_and(|n| n > 0));
            assert!(usage["output_tokens"].as_u64().is_some_and(|n| n > 0));
            assert_eq!(
                usage["cost"]["available"], true,
                "list-price usage required"
            );
            // Never allow a card: scenario teardown cancels the pending turn.
            s.finish().await?;
        }
    }
    live::report(
        "LIVE-BROWSE-SHOP",
        &format!(
            "Off success={}/5 Auto success={}/5",
            successes[0], successes[1]
        ),
    );
    assert_eq!(successes, [5, 5]);
    Ok(())
}

async fn verify(s: &Scenario, turn: &Value) -> Result<bool, HarnessError> {
    if turn["state"] != "waiting_for_form" {
        return Ok(false);
    }
    // The public turn state can arrive just before the approval projection.
    let mut cards = Vec::new();
    for _ in 0..100 {
        cards = s.gw.approval_requests("general").await?;
        if !cards.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if cards.len() != 1 {
        return Ok(false);
    }
    let operation = &cards[0]["approval"]["operation"];
    let steps = operation["browser_steps"].as_array();
    let exact = operation["tool"] == "browser_act"
        && steps.is_some_and(|steps| {
            steps.len() == 1 && steps[0]["action"] == "click" && steps[0]["name"] == "Place order"
        });
    if !exact {
        return Ok(false);
    }
    let admin = crate::live::hedge_v2::preflight::admin(s);
    let observed = admin.send(Method::POST, "/internal/browser/calls", Some(json!({
        "op":"tab.observe","session":"general","tab":operation["browser_tab"],"args":{"include_image":false}
    })), &[]).await?;
    let text = observed.body["text"].as_str().unwrap_or("");
    Ok(observed.status == 200
        && text.contains("Checkout")
        && text.contains("Birch desk lamp")
        && !text.contains("Aster desk lamp")
        && text.contains("Order not placed"))
}

fn rounds(s: &Scenario, turn: &str) -> Result<u64, HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    Ok(db.query_row(
        "SELECT COUNT(*) FROM btcc_model_round_acceptances WHERE turn_id=?1",
        [turn],
        |r| r.get(0),
    )?)
}
