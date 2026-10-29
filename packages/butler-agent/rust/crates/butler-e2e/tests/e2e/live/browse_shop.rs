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
        let mut records = Vec::new();
        for run in 1..=5 {
            let record = run_shop(provider.clone(), setting, run).await?;
            successes[mode] += usize::from(record["success"] == true);
            live::report("LIVE-BROWSE-SHOP", &record.to_string());
            records.push(record);
        }
        let sum = |key: &str| {
            records
                .iter()
                .map(|record| record[key].as_u64().unwrap())
                .sum::<u64>()
        };
        let cost: f64 = records
            .iter()
            .map(|record| record["list_price_cost"]["usd"].as_f64().unwrap())
            .sum();
        live::report(
            "LIVE-BROWSE-SHOP",
            &json!({"summary":true,"setting":setting,
            "runs":records.len(),"successes":successes[mode],
            "success_rate":successes[mode] as f64 / records.len() as f64,
            "rounds":sum("rounds"),"input_tokens":sum("input_tokens"),
            "output_tokens":sum("output_tokens"),"list_price_cost":{"available":true,"usd":cost}})
            .to_string(),
        );
    }
    assert_eq!(successes, [5, 5]);
    Ok(())
}

async fn run_shop(
    provider: LiveProvider,
    setting: &str,
    run: usize,
) -> Result<Value, HarnessError> {
    live::spend_turn()?;
    let s = Setup::new("LIVE-BROWSE-SHOP")?
        .live(provider)
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
    let id = s.gw.say_turn("general", &prompt).await?;
    let turn =
        s.gw.wait_turn(
            "general",
            &id,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(300),
        )
        .await?;
    let success = verify(&s, &turn).await?;
    let usage = s.gw.get("/session-view?session_id=general").await?;
    let usage = &usage.data()["usage"];
    let rounds = rounds(&s, &id)?;
    let record = json!({"setting":setting,"run":run,"success":success,"rounds":rounds,
        "executor_requests":usage["by_role"]["browse"]["request_count"].as_u64().unwrap_or(0),
        "input_tokens":usage["input_tokens"],"output_tokens":usage["output_tokens"],
        "list_price_cost":usage["cost"]});
    assert!(usage["input_tokens"].as_u64().is_some_and(|n| n > 0));
    assert!(usage["output_tokens"].as_u64().is_some_and(|n| n > 0));
    assert_eq!(
        usage["cost"]["available"], true,
        "list-price usage required"
    );
    assert!(
        usage["cost"]["usd"].as_f64().is_some(),
        "list-price USD required"
    );
    // Never allow a card: scenario teardown cancels the pending turn.
    s.finish().await?;
    Ok(record)
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
