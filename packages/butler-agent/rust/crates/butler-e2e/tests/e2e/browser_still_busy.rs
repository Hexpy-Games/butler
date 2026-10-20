//! Backpressure on the real host transport must settle reserved receipts.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use butler_e2e::e2e::{HarnessError, scenario::Setup, security::AdminClient};
use reqwest::Method;
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn browser_still_busy_dispatch_settles_reserved_steps() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-STILL-BUSY")?.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    // Keep the SSE response open without reading: large legal control frames
    // fill the socket and then the bounded host channel, without taking page slots.
    let stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    let tabs = json!({"tabs":[{"id":"page","owner":"conversation:general","profile":"signed_out","epoch":1,"holder":"agent","url":"https://example.com"}]});
    assert_eq!(
        admin
            .send(
                Method::POST,
                "/internal/browser-host/events",
                Some(tabs),
                &[]
            )
            .await?
            .status,
        200
    );
    let mut fillers = tokio::task::JoinSet::new();
    for _ in 0..512 {
        let caller = admin.clone();
        fillers.spawn(async move {
            caller.send(Method::POST, "/internal/browser/calls", Some(json!({
                "op":"owner.closed","session":"general","args":{"padding":"x".repeat(60 * 1024)}
            })), &[]).await
        });
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(reply) = fillers.join_next().await {
            let reply = reply.unwrap()?;
            assert!(
                matches!(reply.status, 200 | 429),
                "control status {}: {}",
                reply.status,
                reply.text
            );
            if reply.status == 429 {
                assert!(reply.text.contains("browser_busy"));
                return Ok::<_, HarnessError>(());
            }
        }
        panic!("host transport never reached backpressure");
    })
    .await
    .unwrap()?;
    let reply = admin.send(Method::POST, "/internal/browser/calls", Some(json!({
        "op":"tab.act","session":"general","tab":"page","args":{"steps":[{"action":"wait","value":"50"},{"action":"wait","value":"50"}]}
    })), &[]).await?;
    assert_eq!(reply.status, 429, "{}", reply.text);
    assert!(reply.text.contains("browser_busy"));
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let rows: Vec<(String, Option<String>)> = db
        .prepare("SELECT state,reason FROM browser_still_deliveries ORDER BY step")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    assert_eq!(
        rows,
        vec![("failed".into(), Some("dispatch_interrupted".into())); 2]
    );
    drop(db);
    drop(stream);
    fillers.abort_all();
    while fillers.join_next().await.is_some() {}
    s.finish().await
}
