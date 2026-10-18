//! LOG-HTTP-03: actual gateway setup and MCP operations, one record per wire call.
use super::super::setup_oauth::{auth_param, callback, flow_until, start};
use super::*;
use butler_e2e::e2e::{
    agent::free_port,
    fake_servers::GOOD_KEY,
    scenario::{Fixture, Scenario, Setup},
};

async fn assert_seen(s: &Scenario, server: &FakeServer) -> Result<(), HarnessError> {
    let port = url::Url::parse(&server.base_url).unwrap().port().unwrap();
    let reply = s.gw.get("/logs?category=http.client&limit=1000").await?;
    let rows: Vec<_> = reply.data()["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["event"] == "http.request" && r["attrs"]["port"] == port)
        .collect();
    let seen = server.seen();
    assert!(!seen.is_empty(), "fixture must receive real HTTP");
    assert_eq!(rows.len(), seen.len(), "one completion record per call");
    let mut expected: Vec<_> = seen
        .iter()
        .map(|r| (r.method.clone(), r.path.clone()))
        .collect();
    let mut actual: Vec<_> = rows
        .iter()
        .map(|r| {
            (
                r["attrs"]["method"].as_str().unwrap().to_owned(),
                r["attrs"]["path"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    expected.sort();
    actual.sort();
    assert_eq!(actual, expected);
    for row in rows {
        assert!(row["attrs"]["status"].is_number());
        assert!(row["attrs"]["request_bytes"].is_number());
        assert!(row["attrs"]["response_bytes"].is_number());
    }
    assert!(!reply.text.contains(GOOD_KEY));
    assert!(!reply.text.contains("outbound-mcp-fixture-token"));
    assert!(seen.iter().all(|r| !r.headers.contains_key("traceparent")));
    Ok(())
}

#[tokio::test]
async fn log_http_setup_oauth_local_models_and_mcp_are_logged_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let models = FakeServer::provider_models().await?;
    let token = FakeServer::oauth_token().await?;
    let local = FakeServer::local_models(ChatBehavior::default()).await?;
    let mcp = FakeServer::mcp_http().await?;
    let icons = FakeServer::favicons().await?;
    let port = free_port()?;
    let s = Setup::new("LOG-HTTP-03")?
        .fixture(Fixture::Empty)
        .without_credential()
        .env("OPENAI_BASE_URL", format!("{}/v1", models.base_url))
        .env("BUTLER_E2E_FAVICON_ORIGIN", &icons.base_url)
        .env("BUTLER_OLLAMA_BASE_URL", &local.base_url)
        .env("BUTLER_LM_STUDIO_BASE_URL", &local.base_url)
        .env("BUTLER_CODEX_OAUTH_PORT", port.to_string())
        .env(
            "BUTLER_CODEX_OAUTH_TOKEN_URL",
            format!("{}/oauth/token", token.base_url),
        )
        .start()
        .await?;
    logging(&s, "detailed").await?;
    assert_eq!(
        s.gw.post(
            "/setup/credentials/verify",
            json!({"provider_id":"openai","api_key":GOOD_KEY})
        )
        .await?
        .status,
        200
    );
    assert_eq!(s.gw.get("/setup/local-model-servers").await?.status, 200);
    let flow = start(&s.gw, json!({})).await?;
    let state = auth_param(&flow, "state");
    assert_eq!(
        callback(port, &format!("code=e2e-code&state={state}"))
            .await?
            .0,
        200
    );
    assert_eq!(
        flow_until(&s.gw, flow["flow_id"].as_str().unwrap(), "completed").await?["status"],
        "completed"
    );
    let added = s.gw.post("/mcp-servers",json!({"id":"e2e","display_name":"HTTP fixture","enabled":true,"transport":"http","url":format!("{}/mcp",mcp.base_url),"headers":[{"key":"Authorization","source":"literal","value":"Bearer outbound-mcp-fixture-token"}]})).await?;
    assert!(added.status < 300, "{}", added.text);
    let probe = super::super::mcp::probe(&s).await?;
    assert!(super::super::mcp::healthy(&probe), "{probe}");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let response =
                s.gw.http()
                    .get(format!("{}/favicons?host=logged.invalid", s.gw.base))
                    .bearer_auth(&s.gw.token)
                    .send()
                    .await?;
            if response.status() == 200 {
                assert!(!response.bytes().await?.is_empty());
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Ok::<_, HarnessError>(())
    })
    .await
    .expect("favicon fixture fetch missing")?;
    for server in [&models, &token, &local, &mcp, &icons] {
        assert_seen(&s, server).await?;
    }
    s.finish().await
}

#[tokio::test]
async fn log_http_mcp_path_token_is_scrubbed() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    use std::io::Read;
    let mcp = FakeServer::mcp_http().await?;
    let s = Setup::new("LOG-HTTP-PATH")?.start().await?;
    logging(&s, "full").await?;
    let secret = "0123456789abcdef0123456789abcdef";
    let endpoint = format!("{}/s/{secret}/mcp", mcp.base_url);
    let added = s.gw.post("/mcp-servers", json!({"id":"e2e","display_name":"Path token","enabled":true,"transport":"http","url":endpoint})).await?;
    assert!(added.status < 300);
    let probe = s.gw.post("/mcp-servers/e2e/probe", json!({})).await?;
    assert!(probe.status < 300, "MCP probe failed");
    assert!(super::super::mcp::healthy(&probe.body));
    let closed_port = free_port()?;
    let refused_endpoint = format!("http://127.0.0.1:{closed_port}/s/{secret}/mcp");
    assert_eq!(
        s.gw.patch("/mcp-servers/e2e", json!({"url":refused_endpoint}))
            .await?
            .status,
        200
    );
    let failed = s.gw.post("/mcp-servers/e2e/probe", json!({})).await?;
    assert!(!super::super::mcp::healthy(&failed.body));
    let logs = s.gw.get("/logs?category=http.client&limit=1000").await?;
    assert!(!logs.text.contains(secret));
    let rows = logs.data()["rows"].as_array().unwrap();
    assert!(
        rows.iter()
            .any(|row| row["level"] == "ERROR" && row["attrs"]["purpose"] == "mcp")
    );
    assert!(rows.iter().any(|row| row["attrs"]["purpose"] == "mcp"));
    for row in rows {
        if let Some(reference) = row["body_ref"].as_str() {
            let body = s.gw.get(&format!("/logs/bodies/{reference}")).await?;
            assert!(!body.text.contains(secret));
        }
    }
    let response =
        s.gw.http()
            .post(format!("{}/logs/export", s.gw.base))
            .bearer_auth(&s.gw.token)
            .json(&json!({"include_bodies":true}))
            .send()
            .await?;
    assert_eq!(response.status(), 200);
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(response.bytes().await?)).unwrap();
    for n in 0..archive.len() {
        let mut file = archive.by_index(n).unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let bytes = if file.name().ends_with(".zst") {
            zstd::decode_all(bytes.as_slice())?
        } else {
            bytes
        };
        assert!(!String::from_utf8_lossy(&bytes).contains(secret));
    }
    for entry in walkdir(&s.sandbox.data.join("logs"))? {
        assert!(!String::from_utf8_lossy(&entry).contains(secret));
    }
    s.finish().await
}
fn walkdir(root: &std::path::Path) -> Result<Vec<Vec<u8>>, HarnessError> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            files.extend(walkdir(&entry.path())?);
        } else {
            files.push(std::fs::read(entry.path())?);
        }
    }
    Ok(files)
}
