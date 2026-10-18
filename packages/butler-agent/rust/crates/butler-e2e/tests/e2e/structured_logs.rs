//! LOG-01..07, LOG-SEC-01 and LOG-IDLE-01: public gateway and durable storage.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::{Value, json};
use std::time::Duration;

async fn configure(
    s: &butler_e2e::e2e::scenario::Scenario,
    level: &str,
) -> Result<Value, HarnessError> {
    let r =
        s.gw.send(
            reqwest::Method::PUT,
            "/logs/config",
            Some(json!({"level":level,"category_levels":{}}).to_string()),
        )
        .await?;
    assert_eq!(r.status, 200, "{}", r.text);
    Ok(r.data().clone())
}

#[tokio::test]
async fn logs_records_gateway_requests_at_standard() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("LOG-01")?.start().await?;
    s.gw.patch("/settings", json!({"diagnostics_enabled":true}))
        .await?;
    s.gw.patch(
        "/settings?token=should-never-be-written",
        json!({"reduce_motion":true}),
    )
    .await?;
    let r = s.gw.get("/logs?category=http.server").await?;
    assert_eq!(r.status, 200, "{}", r.text);
    let rows = r.data()["rows"].as_array().unwrap();
    let row = rows
        .iter()
        .find(|r| r["attrs"]["method"] == "PATCH")
        .unwrap();
    for field in [
        "ts",
        "level",
        "process",
        "category",
        "event",
        "msg",
        "duration_ms",
    ] {
        assert!(!row[field].is_null(), "{field}: {row}");
    }
    assert_eq!(row["event"], "http.request");
    assert_eq!(row["process"], "agent");
    assert!(row.get("content").is_none());
    assert!(!r.text.contains("should-never-be-written"));
    s.finish().await
}

#[tokio::test]
async fn logs_level_lowering_deletes_verbose_dirs() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("LOG-02")?.start().await?;
    s.gw.patch("/settings", json!({"diagnostics_enabled":true}))
        .await?;
    configure(&s, "full").await?;
    s.gw.get("/health").await?;
    let r = configure(&s, "standard").await?;
    assert!(r["freed_bytes"].as_u64().unwrap() > 0);
    for name in ["debug", "bodies"] {
        assert!(!s.sandbox.data.join("logs/agent").join(name).exists());
    }
    s.finish().await
}

#[tokio::test]
async fn logs_full_reverts_on_restart_and_expiry() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("LOG-03")?.start().await?;
    s.gw.patch("/settings", json!({"diagnostics_enabled":true}))
        .await?;
    configure(&s, "detailed").await?;
    let r = configure(&s, "full").await?;
    assert!(r["full_expires_at"].is_string());
    s.restart().await?;
    assert_eq!(
        s.gw.get("/logs/config").await?.data()["effective"]["level"],
        "detailed"
    );
    configure(&s, "full").await?;
    let r = s.gw.post("/internal/e2e/logs/expire", json!({})).await?;
    assert_eq!(r.status, 200, "{}", r.text);
    assert_eq!(
        s.gw.get("/logs/config").await?.data()["effective"]["level"],
        "detailed"
    );
    s.finish().await
}

#[tokio::test]
async fn logs_developer_mode_required() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("LOG-06")?.start().await?;
    for path in [
        "/logs",
        "/logs/live",
        "/logs/storage",
        "/logs/config",
        "/logs/bodies/unknown",
    ] {
        let r = s.gw.get(path).await?;
        assert_eq!(r.status, 403, "{path}: {}", r.text);
        assert_eq!(r.error_code(), Some("developer_mode_required"));
    }
    for method in [reqwest::Method::PUT, reqwest::Method::DELETE] {
        let path = if method == reqwest::Method::PUT {
            "/logs/config"
        } else {
            "/logs"
        };
        assert_eq!(
            s.gw.send(method, path, Some("{}".into())).await?.status,
            403
        );
    }
    s.finish().await
}

#[tokio::test]
async fn logs_export_manifest() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("LOG-07")?.start().await?;
    let response =
        s.gw.http()
            .post(format!("{}/logs/export", s.gw.base))
            .bearer_auth(&s.gw.token)
            .json(&json!({"include_bodies":true}))
            .send()
            .await?;
    assert_eq!(response.status(), 200);
    let bytes = response.bytes().await?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let manifest: Value =
        serde_json::from_reader(archive.by_name("manifest.json").unwrap()).unwrap();
    assert_eq!(manifest["version"], 1);
    assert_eq!(manifest["include_bodies"], false);
    assert!(archive.file_names().all(|n| !n.contains("/bodies/")));
    s.finish().await
}

#[tokio::test]
async fn logs_idle_zero_writes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("LOG-IDLE-01")?.start().await?;
    s.gw.patch("/settings", json!({"reduce_motion":true}))
        .await?;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let mut watch = super::idle_resources::writes::Watch::open_after_quiet(&s.sandbox.data).await?;
    tokio::time::sleep(Duration::from_secs(60)).await;
    watch.assert_unchanged();
    eprintln!("LOG-IDLE-01 window_s=60 written_bytes=0");
    s.finish().await
}

#[tokio::test]
async fn logs_gateway_and_pairing_credentials_are_scrubbed() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let provider_key = "registered-provider-literal-credential";
    let s = Setup::new("LOG-SEC-01")?
        .env("OPENAI_API_KEY", provider_key)
        .start()
        .await?;
    s.gw.patch("/settings", json!({"diagnostics_enabled":true}))
        .await?;
    configure(&s, "full").await?;
    let admin = butler_e2e::e2e::security::AdminClient::new(
        s.gw.clone(),
        s.agent.launch.admin_credential().unwrap(),
    );
    let issued = admin
        .send(reqwest::Method::POST, "/security/pairing", None, &[])
        .await?;
    assert_eq!(issued.status, 200);
    let pin = issued.data()["code"].as_str().unwrap();
    let path = format!("/log-probe/{}/{pin}/{provider_key}", s.gw.token);
    assert_eq!(s.gw.post(&path, json!({})).await?.status, 404);
    let logs = s.gw.get("/logs?category=http.server").await?;
    assert!(logs.data()["rows"].as_array().unwrap().iter().any(|r| {
        r["attrs"]["route"]
            .as_str()
            .is_some_and(|r| r == "<unmatched>")
    }));
    let secrets = [s.gw.token.as_str(), pin, provider_key];
    for secret in secrets {
        assert!(!logs.text.contains(secret));
    }
    let response =
        s.gw.http()
            .post(format!("{}/logs/export", s.gw.base))
            .bearer_auth(&s.gw.token)
            .json(&json!({"include_bodies":true}))
            .send()
            .await?;
    assert_eq!(response.status(), 200);
    let bytes = response.bytes().await?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    for n in 0..archive.len() {
        use std::io::Read;
        let mut file = archive.by_index(n).unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let bytes = if file.name().ends_with(".zst") {
            zstd::decode_all(bytes.as_slice())?
        } else {
            bytes
        };
        for secret in secrets {
            assert!(!String::from_utf8_lossy(&bytes).contains(secret));
        }
    }
    s.finish().await
}

#[tokio::test]
async fn logs_live_closes_with_gateway() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("LOG-LIVE")?.start().await?;
    s.gw.patch("/settings", json!({"diagnostics_enabled":true}))
        .await?;
    let mut response =
        s.gw.http()
            .get(format!("{}/logs/live", s.gw.base))
            .bearer_auth(&s.gw.token)
            .send()
            .await?;
    assert_eq!(response.status(), 200);
    s.gw.patch("/settings", json!({"reduce_motion":true}))
        .await?;
    let frame = tokio::time::timeout(Duration::from_secs(5), async {
        let mut frame = String::new();
        while !frame.contains("\n\n") {
            let chunk = response
                .chunk()
                .await?
                .expect("live stream ended before a record");
            frame.push_str(&String::from_utf8_lossy(&chunk));
        }
        Ok::<_, reqwest::Error>(frame)
    })
    .await
    .unwrap()?;
    let row: Value = serde_json::from_str(
        frame
            .lines()
            .find_map(|line| line.strip_prefix("data:"))
            .unwrap()
            .trim(),
    )
    .unwrap();
    assert_eq!(row["process"], "agent");
    s.agent.terminate().await?;
    tokio::time::timeout(Duration::from_secs(5), async {
        while response.chunk().await?.is_some() {}
        Ok::<_, reqwest::Error>(())
    })
    .await
    .unwrap()?;
    s.finish().await
}

#[tokio::test]
async fn logs_rejected_requests_never_store_raw_paths() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("LOG-ADMISSION")?.start().await?;
    s.gw.patch("/settings", json!({"diagnostics_enabled":true}))
        .await?;
    configure(&s, "detailed").await?;
    let path = format!("/{}", uuid::Uuid::new_v4().to_string().repeat(150));
    let response =
        s.gw.http()
            .post(format!("{}{path}", s.gw.base))
            .header("origin", "https://untrusted.example")
            .body("probe")
            .send()
            .await?;
    assert!(!response.status().is_success());
    let rows = s.gw.get("/logs?category=http.server").await?;
    assert!(!rows.text.contains(&path));
    let rejected = rows.data()["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["attrs"]["method"] == "POST" && r["attrs"]["route"] == "<unmatched>")
        .unwrap();
    assert_eq!(rejected["level"], "DEBUG");
    s.finish().await
}

#[tokio::test]
async fn logs_uppercase_override_is_normalized() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("LOG-LEVEL-CASE")?.start().await?;
    s.gw.patch("/settings", json!({"diagnostics_enabled":true}))
        .await?;
    let r =
        s.gw.send(
            reqwest::Method::PUT,
            "/logs/config",
            Some(json!({"level":"standard","category_levels":{"turn":"DEBUG"}}).to_string()),
        )
        .await?;
    assert_eq!(r.status, 200, "{}", r.text);
    assert_eq!(r.data()["effective"]["category_levels"]["turn"], "debug");
    s.finish().await
}

#[tokio::test]
async fn logs_live_ends_when_developer_mode_disabled() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("LOG-LIVE-DISABLE")?.start().await?;
    s.gw.patch("/settings", json!({"diagnostics_enabled":true}))
        .await?;
    let mut response =
        s.gw.http()
            .get(format!("{}/logs/live", s.gw.base))
            .bearer_auth(&s.gw.token)
            .send()
            .await?;
    assert_eq!(response.status(), 200);
    s.gw.patch("/settings", json!({"diagnostics_enabled":false}))
        .await?;
    tokio::time::timeout(Duration::from_secs(5), async {
        while response.chunk().await?.is_some() {}
        Ok::<_, reqwest::Error>(())
    })
    .await
    .unwrap()?;
    s.finish().await
}

#[tokio::test]
async fn logs_use_router_templates_for_ids() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("LOG-ROUTES")?.start().await?;
    s.gw.patch("/settings", json!({"diagnostics_enabled":true}))
        .await?;
    configure(&s, "detailed").await?;
    let id = uuid::Uuid::new_v4().to_string();
    s.gw.get(&format!("/automations/{id}")).await?;
    s.gw.send(reqwest::Method::DELETE, &format!("/mcp-servers/{id}"), None)
        .await?;
    let rows = s.gw.get("/logs?category=http.server").await?;
    assert!(!rows.text.contains(&id));
    for template in ["/automations/{id}", "/mcp-servers/{id}"] {
        assert!(
            rows.data()["rows"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["attrs"]["route"] == template)
        );
    }
    s.finish().await
}
