//! A saved key is visible and polled only while a registered model binds it.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use axum::{Json, Router, routing::get};
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

struct QuotaServer {
    task: tokio::task::JoinHandle<()>,
    calls: Arc<AtomicUsize>,
    base: String,
}
impl Drop for QuotaServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl QuotaServer {
    async fn start() -> Result<Self, HarnessError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}/api/coding/paas/v4", listener.local_addr()?);
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let app = Router::new().route("/api/monitor/usage/quota/limit",get(move || {
            let count = count.clone();
            async move {
                count.fetch_add(1,Ordering::SeqCst);
                Json(json!({"success":true,"code":200,"data":{"level":"lite","limits":[{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":25}]}}))
            }
        }));
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Ok(Self { task, calls, base })
    }
}
async fn providers(s: &Scenario) -> Result<Value, HarnessError> {
    let reply = s.gw.get("/usage-monitor").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data()["providerUsage"]["providers"].clone())
}
async fn refresh(s: &Scenario) -> Result<Value, HarnessError> {
    let reply =
        s.gw.get("/provider-quota?provider_id=zai&refresh=1")
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}
#[tokio::test]
async fn quota_gating_registered_credential_lifecycle() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = QuotaServer::start().await?;
    let setup = Setup::new("quota-gating")?
        .without_credential()
        .quota_polling()
        .env("BUTLER_ZAI_BASE_URL", &server.base);
    let metrics = setup.sandbox.data.join("metrics");
    std::fs::create_dir_all(&metrics)?;
    std::fs::write(
        metrics.join("provider-quota.json"),
        serde_json::to_vec(&json!({"providers":{"zai":{
            "provider_id":"zai","windows":[],"observed_at_ms":chrono::Utc::now().timestamp_millis(),"plan_name":"old","source":"usage_endpoint"
        }}}))?,
    )?;
    let s = setup.start().await?;
    let credential =
        s.gw.post(
            "/model-catalog/provider-credentials",
            json!({"provider_id":"zai","auth_type":"api_key","api_key":"quota-stub-key"}),
        )
        .await?;
    assert!(credential.status < 300, "{}", credential.text);
    let id = credential.data()["credential"]["id"].as_str().unwrap();
    // A stale persisted reading must not turn a credential into a registered model.
    assert_eq!(providers(&s).await?, json!([]));
    assert_eq!(refresh(&s).await?["available"], false);
    assert_eq!(server.calls.load(Ordering::SeqCst), 0);
    let model = s.gw.post("/model-catalog/registered-models",json!({"provider_id":"zai","model_id":"glm-5.3","auth_type":"api_key","credential_id":id})).await?;
    assert!(model.status < 300, "{}", model.text);
    let quota = refresh(&s).await?;
    assert_eq!(quota["available"], true, "{quota}");
    assert_eq!(server.calls.load(Ordering::SeqCst), 1);
    let rows = providers(&s).await?;
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["providerId"], "zai");
    let deleted =
        s.gw.delete("/model-catalog/registered-models/zai%2Fglm-5.3")
            .await?;
    assert!(deleted.status < 300, "{}", deleted.text);
    assert_eq!(providers(&s).await?, json!([]));
    let hidden = refresh(&s).await?;
    assert_eq!(hidden["available"], false);
    assert_eq!(hidden["windows"], json!([]));
    let until = tokio::time::Instant::now() + Duration::from_millis(250);
    while tokio::time::Instant::now() < until {
        refresh(&s).await?;
        assert_eq!(server.calls.load(Ordering::SeqCst), 1);
        tokio::task::yield_now().await;
    }
    s.finish().await
}
