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
        // A model without a published list price has no USD total.
        let cost: Option<f64> = records
            .iter()
            .map(|record| record["list_price_cost"]["usd"].as_f64())
            .sum();
        live::report(
            "LIVE-BROWSE-SHOP",
            &json!({"summary":true,"setting":setting,
            "runs":records.len(),"successes":successes[mode],
            "success_rate":successes[mode] as f64 / records.len() as f64,
            "rounds":sum("rounds"),"input_tokens":sum("input_tokens"),
            "output_tokens":sum("output_tokens"),"list_price_cost":{"available":cost.is_some(),"usd":cost}})
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
    let priced = published_price(&provider.choice.model);
    let mut s = Setup::new("LIVE-BROWSE-SHOP")?
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
    let started = std::time::Instant::now();
    let id = s.gw.say_turn("general", &prompt).await?;
    let outcome = wait_card(&s, &id, started).await?;
    let wall_seconds = started.elapsed().as_secs_f64();
    let clip = |text: &str| text.chars().take(600).collect::<String>();
    let timeout = outcome.timeout.as_deref().map(clip);
    let turn = &outcome.parent;
    let success = outcome.card_seconds.is_some() && verify(&s).await?;
    let usage = s.gw.get("/session-view?session_id=general").await?;
    let usage = &usage.data()["usage"];
    let table = round_table(&s)?;
    let parent_rounds = table.iter().filter(|r| r["turn"] == id.as_str()).count();
    let reply = last_reply(&s, &id).await?;
    let record = json!({"setting":setting,"run":run,"success":success,
        "rounds":table.len(),"parent_rounds":parent_rounds,"round_table":table,
        "delegated":outcome.delegated,"card_seconds":outcome.card_seconds,
        "state": if timeout.is_some() { json!("timeout") } else { turn["state"].clone() },
        "turn_state":turn["state"],"status_label":turn["safe_status_label"],
        "error_code":turn["safe_error_code"],"timeout_error":timeout,
        "reply":reply["text"].as_str().map(clip),"reply_status":reply["status"],
        "reply_error_code":reply["safe_error_code"],
        "tools":tools(&s, &id)?,"wall_seconds":wall_seconds,
        "executor_requests":usage["by_role"]["browse"]["request_count"].as_u64().unwrap_or(0),
        "usage_by_role":usage["by_role"],
        "input_tokens":usage["input_tokens"],"output_tokens":usage["output_tokens"],
        "list_price_cost":usage["cost"]});
    // A timed-out turn may not have finished a model request yet; usage is
    // asserted for every run that ended before the deadline, as before.
    if timeout.is_none() {
        assert_usage(usage, priced);
    }
    if success {
        // Never allow a card: scenario teardown cancels the pending turn.
        s.finish().await?;
    } else {
        // Keep the failed sandbox (no mark_success). Stop the agent first so
        // its browser releases the profile before Drop moves the sandbox.
        if let Err(error) = s.agent.terminate().await {
            eprintln!("LIVE-BROWSE-SHOP: agent stop before retention: {error}");
        }
    }
    Ok(record)
}

async fn verify(s: &Scenario) -> Result<bool, HarnessError> {
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

/// Every accepted model round in the sandbox, in acceptance order: the
/// turn, its policy role (butler, steward or worker), model and acceptance time.
fn round_table(s: &Scenario) -> Result<Vec<Value>, HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let mut query = db.prepare(
        "SELECT a.turn_id, json_extract(t.context_json,'$.executionPolicy.role'), \
         a.model_ref, a.created_at FROM btcc_model_round_acceptances a \
         LEFT JOIN btcc_turns t ON t.turn_id=a.turn_id ORDER BY a.created_at, a.rowid",
    )?;
    let rows = query.query_map([], |r| {
        let (turn, role, model, at): (String, Option<String>, String, String) =
            (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?);
        Ok(json!({"turn":turn,"role":role,"model":model,"accepted_at":at}))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// How the user's request ended in the chat.
struct Outcome {
    parent: Value,
    delegated: bool,
    card_seconds: Option<f64>,
    timeout: Option<String>,
}

/// Polls the chat once a second from the user's message until an approval
/// card waits in it, no work for this request can still raise one, or 300 s
/// pass. Children's cards are owned by the root chat, so one read covers the
/// parent turn and any Steward it delegated to.
async fn wait_card(
    s: &Scenario,
    id: &str,
    started: std::time::Instant,
) -> Result<Outcome, HarnessError> {
    let deadline = Duration::from_secs(300);
    let mut idle_polls = 0;
    loop {
        let parent = s.gw.turn("general", id).await?.unwrap_or(Value::Null);
        let view = s.gw.get("/session-view?session_id=general").await?;
        let view = view.data();
        let children = view["steward_children"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let outcome = |card_seconds, timeout| Outcome {
            parent: parent.clone(),
            delegated: !children.is_empty(),
            card_seconds,
            timeout,
        };
        if !s.gw.approval_requests("general").await?.is_empty() {
            return Ok(outcome(Some(started.elapsed().as_secs_f64()), None));
        }
        // A child still works unless it has its result, a retryable fault or no live turn.
        let working = children.iter().any(|c| {
            c["terminal"] != true
                && c["latest_turn"]["retryable"] != true
                && c["result_missing"] != true
        });
        let settled = matches!(
            view["latest_turn"]["state"].as_str(),
            Some("delivered" | "waiting_for_form" | "failed" | "runtime_fault" | "cancelled")
        );
        // Two idle reads a second apart: a Steward's result queues the parent's
        // follow-up turn just after the child turns terminal.
        idle_polls = if settled && !working {
            idle_polls + 1
        } else {
            0
        };
        let failed = matches!(
            parent["state"].as_str(),
            Some("failed" | "runtime_fault" | "cancelled")
        );
        if failed || idle_polls == 2 {
            return Ok(outcome(None, None));
        }
        if started.elapsed() > deadline {
            let last = format!("no approval card within {deadline:?}; last turn: {parent}");
            return Ok(outcome(None, Some(last)));
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// Usage of a run that ended before the deadline.
fn assert_usage(usage: &Value, priced: bool) {
    assert!(usage["input_tokens"].as_u64().is_some_and(|n| n > 0));
    assert!(usage["output_tokens"].as_u64().is_some_and(|n| n > 0));
    // A subscription plan has no list price; require it where the catalog publishes one.
    if priced {
        assert_eq!(
            usage["cost"]["available"], true,
            "list-price usage required"
        );
        assert!(
            usage["cost"]["usd"].as_f64().is_some(),
            "list-price USD required"
        );
    }
}

/// The parent turn's last assistant message, or null.
async fn last_reply(s: &Scenario, id: &str) -> Result<Value, HarnessError> {
    Ok(s.gw
        .messages("general")
        .await?
        .into_iter()
        .rev()
        .find(|m| m["turn_id"] == id && m["role"] == "assistant")
        .unwrap_or(Value::Null))
}

/// The turn's tool calls in call order, as `name:status[:error_code]`.
fn tools(s: &Scenario, turn: &str) -> Result<Vec<String>, HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let mut query = db.prepare(
        "SELECT tool_name, status, error_code FROM btcc_guided_tool_calls \
         WHERE turn_id=?1 ORDER BY started_at, turn_sequence, rowid",
    )?;
    let rows = query.query_map([turn], |r| {
        let (name, status, code): (String, String, Option<String>) =
            (r.get(0)?, r.get(1)?, r.get(2)?);
        Ok(match code {
            Some(code) => format!("{name}:{status}:{code}"),
            None => format!("{name}:{status}"),
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Whether the catalog publishes a list price for `model` (`provider/model`).
fn published_price(model: &str) -> bool {
    let catalog: Value = serde_json::from_str(include_str!(
        "../../../../butler-models/src/models/catalog/static-catalog.json"
    ))
    .unwrap();
    catalog["models"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|m| m["model_ref"] == model && m["pricing"]["status"] == "published")
}
