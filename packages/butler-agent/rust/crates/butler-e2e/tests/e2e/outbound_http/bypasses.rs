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
