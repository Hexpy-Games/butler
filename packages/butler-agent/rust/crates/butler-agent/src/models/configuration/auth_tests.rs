use std::{fs, path::PathBuf, sync::Arc};

use base64::Engine as _;
use serde_json::{Value, json};
use tokio::{io::AsyncReadExt, io::AsyncWriteExt, net::TcpListener};

use super::*;
use crate::{
    locale::LocaleCollation,
    models::{ModelCatalog, ProviderAuth},
};

struct Clock;
impl ModelConfigurationClock for Clock {
    fn now_iso(&self) -> String {
        "2026-09-14T00:00:00.000Z".into()
    }
    fn now_epoch_millis(&self) -> i64 {
        1_757_808_000_000
    }
}

struct Fixture(PathBuf);
impl Fixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "butler-p2c-auth-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn owner(&self, token_url: String) -> ModelConfiguration {
        ModelConfiguration::new(
            self.0.clone(),
            ModelConfigurationEnvironment {
                oauth_token_url: Some(token_url),
                os_platform: Some("darwin".into()),
                os_release: Some("25.0".into()),
                os_arch: Some("arm64".into()),
                ..Default::default()
            },
            Arc::new(Clock),
            Arc::new(ModelCatalog::new().unwrap()),
            Arc::new(LocaleCollation::new("en-US").unwrap()),
            crate::models::provider_http_client().unwrap(),
            Arc::new(crate::configuration::ConfigurationWrites::new()),
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

async fn token_server(status: &str, body: &str) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let status = status.to_owned();
    let body = body.to_owned();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = vec![0; 4096];
        let size = stream.read(&mut bytes).await.unwrap();
        let request = String::from_utf8_lossy(&bytes[..size]).into_owned();
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        request
    });
    (format!("http://{address}/token"), task)
}

fn jwt(payload: &Value) -> String {
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&payload).unwrap());
    format!("header.{encoded}.signature")
}

#[tokio::test]
async fn expiring_profile_refreshes_retains_unknown_fields_and_writes_private_file() {
    let fixture = Fixture::new("refresh");
    let path = fixture.0.join("auth/openai-codex.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        serde_json::to_vec(&json!({
            "type":"oauth", "accessToken":"old", "refreshToken":"refresh",
            "expiresAt":1, "unknown":{"retained":true}
        }))
        .unwrap(),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let access = jwt(&json!({"https://api.openai.com/auth":{"chatgpt_account_id":"account"}}));
    let body = json!({"access_token":access,"expires_in":3600,"scope":"openid"}).to_string();
    let (url, server) = token_server("200 OK", &body).await;
    let owner = fixture.owner(url);
    let auth = owner.auth_owner().resolve_codex().await.unwrap();
    let request = server.await.unwrap();
    assert!(request.contains("grant_type=refresh_token"));
    assert!(matches!(auth, ProviderAuth::Codex { account_id, .. } if account_id == "account"));
    let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved.pointer("/unknown/retained"), Some(&Value::Bool(true)));
    assert_eq!(
        saved.get("accessToken").and_then(Value::as_str),
        Some(access.as_str())
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[tokio::test]
async fn refresh_http_failure_keeps_original_and_invalid_json_is_reported() {
    for (status, body, expected_error) in [
        ("401 Unauthorized", "{}", None),
        ("200 OK", "not-json", Some("provider_auth_refresh_invalid")),
    ] {
        let fixture = Fixture::new("refresh-failure");
        let path = fixture.0.join("auth/openai-codex.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original = json!({
            "type":"oauth", "accessToken":"old", "refreshToken":"refresh", "expiresAt":1
        });
        fs::write(&path, serde_json::to_vec(&original).unwrap()).unwrap();
        let (url, server) = token_server(status, body).await;
        let owner = fixture.owner(url);
        let result = owner.auth_owner().resolve_codex().await;
        server.await.unwrap();
        if let Some(code) = expected_error {
            let Err(error) = result else {
                panic!("expected refresh error")
            };
            assert_eq!(error.code, code);
        } else {
            assert!(
                matches!(result.unwrap(), ProviderAuth::Codex { authorization, .. } if authorization == "Bearer old")
            );
        }
        let saved: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(saved, original);
    }
}

#[tokio::test]
async fn code_exchange_returns_profile_without_writing_it() {
    let fixture = Fixture::new("exchange");
    let access = jwt(&json!({"sub":"account","email":"person@example.com"}));
    let body = json!({
        "access_token":access, "refresh_token":"refresh", "expires_in":3600, "scope":"openid"
    })
    .to_string();
    let (url, server) = token_server("200 OK", &body).await;
    let owner = fixture.owner(url);
    let profile = owner
        .exchange_openai_oauth_code(
            "authorization-code",
            "http://127.0.0.1/callback",
            "verifier",
        )
        .await
        .unwrap();
    let request = server.await.unwrap();
    assert!(request.contains("grant_type=authorization_code"));
    assert_eq!(
        profile.as_json().get("accountId").and_then(Value::as_str),
        Some("account")
    );
    assert!(!fixture.0.join("auth/openai-codex.json").exists());
}

#[tokio::test]
async fn relative_profile_override_is_shared_by_oauth_write_and_model_auth_reader() {
    let fixture = Fixture::new("relative-profile");
    assert_ne!(std::env::current_dir().unwrap(), fixture.0);
    let access = jwt(&json!({"sub":"account","email":"person@example.com"}));
    let (token_url, server) = token_server(
        "200 OK",
        &json!({"access_token":access,"refresh_token":"refresh","expires_in":3600}).to_string(),
    )
    .await;
    let owner = ModelConfiguration::new(
        fixture.0.clone(),
        ModelConfigurationEnvironment {
            butler_codex_auth_profile: Some(PathBuf::from("auth/custom.json")),
            oauth_token_url: Some(token_url),
            os_platform: Some("darwin".into()),
            os_release: Some("25.0".into()),
            os_arch: Some("arm64".into()),
            ..Default::default()
        },
        Arc::new(Clock),
        Arc::new(ModelCatalog::new().unwrap()),
        Arc::new(LocaleCollation::new("en-US").unwrap()),
        crate::models::provider_http_client().unwrap(),
        Arc::new(crate::configuration::ConfigurationWrites::new()),
    )
    .unwrap();
    let profile = owner
        .exchange_openai_oauth_code("code", "http://127.0.0.1/callback", "verifier")
        .await
        .unwrap();
    server.await.unwrap();
    owner.write_openai_auth_profile(&profile).await.unwrap();
    assert!(fixture.0.join("auth/custom.json").exists());
    assert!(!fixture.0.join("auth/openai-codex.json").exists());
    let auth = owner.auth_owner().resolve_codex().await.unwrap();
    assert!(
        matches!(auth, ProviderAuth::Codex { authorization, .. } if authorization == format!("Bearer {access}"))
    );
}

#[tokio::test]
async fn codex_auth_requires_home_fact_but_explicit_missing_file_is_optional() {
    let fixture = Fixture::new("missing-home");
    let owner = fixture.owner("http://127.0.0.1/unused".into());
    let error = owner.auth_owner().resolve_codex().await.err().unwrap();
    assert_eq!(error.code, "provider_home_facts_missing");

    let owner = ModelConfiguration::new(
        fixture.0.clone(),
        ModelConfigurationEnvironment {
            codex_auth_json: Some(fixture.0.join("absent-auth.json")),
            ..Default::default()
        },
        Arc::new(Clock),
        Arc::new(ModelCatalog::new().unwrap()),
        Arc::new(LocaleCollation::new("en-US").unwrap()),
        crate::models::provider_http_client().unwrap(),
        Arc::new(crate::configuration::ConfigurationWrites::new()),
    )
    .unwrap();
    let error = owner.auth_owner().resolve_codex().await.err().unwrap();
    assert_eq!(error.code, "provider_auth_missing");
}

#[tokio::test]
async fn token_exchange_accepts_response_larger_than_one_megabyte() {
    let fixture = Fixture::new("large-token-response");
    let body = json!({
        "access_token":"token",
        "provider_extension":"x".repeat(1024 * 1024 + 1)
    })
    .to_string();
    let (url, server) = token_server("200 OK", &body).await;
    let profile = fixture
        .owner(url)
        .exchange_openai_oauth_code("code", "http://127.0.0.1/callback", "verifier")
        .await
        .unwrap();
    server.await.unwrap();
    assert_eq!(profile.as_json()["accessToken"], "token");
}
