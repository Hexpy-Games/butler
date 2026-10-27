//! Exact rolling sums ignore other accounts and billing paths.
use super::*;
use butler_e2e::e2e::{gateway::turn_state, scenario::Scenario};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, io::Write};
pub(crate) fn account_key(data: &std::path::Path) -> Result<String, HarnessError> {
    let raw: Value = serde_json::from_slice(&fs::read(data.join("auth/chatgpt.json"))?)?;
    Ok(format!(
        "{:x}",
        Sha256::digest(format!(
            "{}\n{}",
            raw["client_id"].as_str().unwrap(),
            raw["subject"].as_str().unwrap()
        ))
    )[..16]
        .into())
}
pub(crate) fn row(ts: i64, account: Option<&str>, auth: &str) -> Value {
    let mut row = json!({"ts":ts,"model":"openai/gpt-6-luna","scope":"seed","authMode":auth,"promptTokens":1000,"cachedTokens":400,"totalTokens":1200});
    if let Some(account) = account {
        row["billingAccount"] = account.into();
    }
    row
}
pub(crate) fn usage(view: &Value) -> &Value {
    &view["providerUsage"]["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["providerId"] == "openai")
        .unwrap()["butlerUsage"]
}
pub(crate) fn assert_windows(view: &Value, expected: [u64; 3]) {
    let usage = usage(view);
    assert_eq!(usage["account"], "chatgpt_plan");
    assert!(usage["asOf"].is_string());
    assert_eq!(usage["windows"].as_array().unwrap().len(), 3);
    for (window, (id, requests)) in usage["windows"]
        .as_array()
        .unwrap()
        .iter()
        .zip(["hours_5", "days_7", "days_30"].into_iter().zip(expected))
    {
        assert_eq!(window["id"], id);
        assert_eq!(window["requests"], requests);
        assert_eq!(
            window["inputTokens"].as_f64(),
            Some((requests * 1000) as f64)
        );
        assert_eq!(
            window["outputTokens"].as_f64(),
            Some((requests * 200) as f64)
        );
        assert_eq!(
            window["totalTokens"].as_f64(),
            Some((requests * 1200) as f64)
        );
    }
}
async fn read(s: &Scenario, path: &str) -> Result<Value, HarnessError> {
    let reply = s.gw.get(path).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}
#[tokio::test]
async fn siwc_17_account_windows_and_incremental_tail() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let base = format!("http://{}/v1", listener.local_addr()?);
    let app = axum::Router::new()
        .route("/v1/responses", axum::routing::post(completed))
        .route_layer(axum::middleware::from_fn(
            butler_e2e::e2e::chatgpt_wire::validate,
        ));
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let s = butler_e2e::e2e::scenario::Setup::new("SIWC-17")?
        .env("BUTLER_CHATGPT_API_BASE_URL", base)
        .start()
        .await?;
    super::register_plan_model(&s).await?;
    let key = account_key(&s.sandbox.data)?;
    let empty = read(&s, "/usage-monitor").await?;
    assert_windows(&empty, [0, 0, 0]);
    assert_eq!(empty["providerUsage"]["activeProviderId"], "openai");
    let provider = &empty["providerUsage"]["providers"][0];
    for field in [
        "requestCount",
        "promptTokens",
        "cachedTokens",
        "uncachedTokens",
        "outputTokens",
        "totalTokens",
        "missingTotalTokenCount",
    ] {
        assert!(provider[field].is_number(), "{provider}");
    }

    let path = s.sandbox.data.join("metrics/prompt-cache-usage.jsonl");
    fs::create_dir_all(path.parent().unwrap())?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    let now = chrono::Utc::now().timestamp_millis();
    for age in [3_600_000, 2 * 86_400_000, 20 * 86_400_000, 40 * 86_400_000] {
        for (account, auth) in [
            (Some(key.as_str()), "subscription"),
            (Some("fedcba9876543210"), "subscription"),
            (Some(key.as_str()), "api_key"),
            (None, "subscription"),
        ] {
            let mut seeded = row(now - age, account, auth);
            if age == 3_600_000 {
                seeded["model"] = "gpt-6-luna".into();
            }
            writeln!(file, "{seeded}")?;
        }
    }
    file.flush()?;
    for path in ["/usage-monitor", "/usage-monitor?session_id=general"] {
        assert_windows(&read(&s, path).await?, [1, 2, 3]);
    }
    // A normal completed turn must write the opaque key itself.
    let (_, turn) = s.turn("general", "usage-account-round").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let text = fs::read_to_string(&path)?;
    let written: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .filter(|row: &Value| row["scope"] != "seed")
        .collect();
    assert!(
        written.iter().any(|row| row["billingAccount"] == key),
        "{written:?}"
    );
    for path in ["/usage-monitor", "/usage-monitor?session_id=general"] {
        assert_windows(&read(&s, path).await?, [2, 3, 4]);
    }
    assert_eq!(
        turn_state(&s.turn("general", "usage-account-round two").await?.1),
        "delivered"
    );
    for path in ["/usage-monitor", "/usage-monitor?session_id=general"] {
        assert_windows(&read(&s, path).await?, [3, 4, 5]);
    }
    task.abort();
    s.finish().await
}

async fn completed(axum::Json(body): axum::Json<Value>) -> impl axum::response::IntoResponse {
    let key = butler_e2e::e2e::matching::key("/v1/responses", &body, &Default::default());
    let mut response = json!({"id":"usage-round","status":"completed","model":"gpt-6-luna","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ready"}]}]});
    if key.user_request.starts_with("usage-account-round") {
        response["usage"] = json!({"input_tokens":1000,"input_tokens_details":{"cached_tokens":400},"output_tokens":200,"total_tokens":1200});
    }
    (
        [("content-type", "text/event-stream")],
        format!(
            "data: {}\n\n",
            json!({"type":"response.completed","response":response})
        ),
    )
}
