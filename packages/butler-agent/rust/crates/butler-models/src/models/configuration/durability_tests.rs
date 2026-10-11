//! Failure injection and independent-owner contention at the real storage ports.
use super::*;
use butler_platform::secrets::ChangeLock;
use serde_json::json;
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

fn interrupted() -> &'static Mutex<HashSet<PathBuf>> {
    static PATHS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    PATHS.get_or_init(Mutex::default)
}

pub(super) fn interrupt_write(path: &Path, file: &mut fs::File) -> std::io::Result<()> {
    if interrupted().lock().unwrap().remove(path) {
        file.write_all(b"partial")?;
        return Err(std::io::Error::new(
            std::io::ErrorKind::WriteZero,
            "injected disk failure",
        ));
    }
    Ok(())
}

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("butler-durability-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("auth")).unwrap();
        Self(root)
    }
    fn owner(&self) -> Arc<ModelConfiguration> {
        self.owner_at("http://127.0.0.1:9/token".into())
    }
    fn owner_at(&self, url: String) -> Arc<ModelConfiguration> {
        Arc::new(
            ModelConfiguration::new(
                self.0.clone(),
                ModelConfigurationEnvironment {
                    oauth_token_url: Some(url),
                    codex_user_agent: Some("test".into()),
                    ..Default::default()
                },
                Arc::new(Clock),
                Arc::new(crate::models::ModelCatalog::new().unwrap()),
                Arc::new(butler_core::locale::LocaleCollation::new("en-US").unwrap()),
                crate::models::provider_http_client().unwrap(),
                Arc::new(butler_core::configuration::ConfigurationWrites::new()),
            )
            .unwrap(),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct Clock;
impl ModelConfigurationClock for Clock {
    fn now_iso(&self) -> String {
        "2026-09-30T00:00:00.000Z".into()
    }
    fn now_epoch_millis(&self) -> i64 {
        1_800_000_000_000
    }
}

pub(super) async fn profile_write_failure() {
    let fixture = Fixture::new();
    let path = fixture.0.join("auth/openai-codex.json");
    let original = br#"{"type":"oauth","accessToken":"old","refreshToken":"fixture"}"#;
    fs::write(&path, original).unwrap();
    interrupted().lock().unwrap().insert(path.clone());
    assert!(
        auth::io::write_mode_600(&path, b"replacement")
            .await
            .is_err()
    );
    assert!(
        fs::read(&path).unwrap() == original,
        "failed profile write lost the login"
    );
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
}

// test-category: security
#[tokio::test]
async fn environment_failure_preserves_every_key_and_success_is_private() {
    let fixture = Fixture::new();
    let path = fixture.0.join(".env");
    let original = b"# retained\nOTHER=fixture\nOPENAI_API_KEY=old\n";
    fs::write(&path, original).unwrap();
    interrupted().lock().unwrap().insert(path.clone());
    let owner = fixture.owner();
    assert!(
        owner
            .upsert_private_environment_value("OPENAI_API_KEY", "new", &fixture.0)
            .await
            .is_err()
    );
    assert!(
        fs::read(&path).unwrap() == original,
        "failed env write lost keys"
    );
    owner
        .upsert_private_environment_value("OPENAI_API_KEY", "new", &fixture.0)
        .await
        .unwrap();
    assert_eq!(
        fs::read(&path).unwrap(),
        b"# retained\nOTHER=fixture\nOPENAI_API_KEY=\"new\"\n"
    );
    assert_ne!(
        butler_platform::secure_fs::is_owner_only(&fs::metadata(&path).unwrap()),
        Some(false)
    );
}

pub(super) async fn refresh_waits_for_other_process() {
    let fixture = Fixture::new();
    let path = fixture.0.join("auth/openai-codex.json");
    fs::write(
        &path,
        json!({"type":"oauth","accessToken":"old","refreshToken":"fixture","expiresAt":1})
            .to_string(),
    )
    .unwrap();
    let lock = ChangeLock::acquire(
        &path.with_file_name("openai-codex.json.lock"),
        Duration::from_secs(1),
    )
    .unwrap();
    let owner = fixture.owner();
    let mut pending = tokio::spawn(async move { owner.auth_owner().resolve_codex().await });
    let early = tokio::time::timeout(Duration::from_millis(100), &mut pending).await;
    let blocked = early.is_err();
    fs::write(&path, json!({"type":"oauth","accessToken":"renewed","refreshToken":"rotated","expiresAt":2_000_000_000_000_i64}).to_string()).unwrap();
    drop(lock);
    let result = match early {
        Ok(result) => result.unwrap(),
        Err(_) => pending.await.unwrap(),
    };
    assert!(blocked, "refresh ignored the other process's lock");
    assert!(
        matches!(result.unwrap(), crate::models::ProviderAuth::Codex { authorization, .. } if authorization == "Bearer renewed")
    );
}

pub(super) async fn config_update_waits_for_other_process() {
    let fixture = Fixture::new();
    let path = fixture.0.join("butler.config.json");
    fs::write(&path, "{}").unwrap();
    let lock = ChangeLock::acquire(
        &path.with_file_name("butler.config.json.lock"),
        Duration::from_secs(1),
    )
    .unwrap();
    let owner = fixture.owner();
    let mut pending = tokio::spawn(async move {
        owner
            .update_user_settings(&json!({"language":"ko"}), None)
            .await
    });
    let early = tokio::time::timeout(Duration::from_millis(100), &mut pending).await;
    let blocked = early.is_err();
    fs::write(
        &path,
        json!({"metrics":{"enabled":true},"unknown":[1,2,3]}).to_string(),
    )
    .unwrap();
    drop(lock);
    match early {
        Ok(result) => result.unwrap(),
        Err(_) => pending.await.unwrap(),
    }
    .unwrap();
    assert!(blocked, "config writer ignored the other process's lock");
    let value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        value,
        json!({"metrics":{"enabled":true},"unknown":[1,2,3],"user":{"language":"ko"}})
    );
}

/// Cancelling a caller cannot release the lock around an in-flight rotation.
pub(super) async fn cancelled_refresh_still_publishes_before_the_next_reader() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let fixture = Fixture::new();
    let path = fixture.0.join("auth/openai-codex.json");
    fs::write(
        &path,
        json!({"type":"oauth","accessToken":"old","refreshToken":"fixture","expiresAt":1})
            .to_string(),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let owner = fixture.owner_at(format!("http://{}/token", listener.local_addr().unwrap()));
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 4096];
        assert!(stream.read(&mut request).await.unwrap() > 0);
        entered_tx.send(()).unwrap();
        release_rx.await.unwrap();
        let body = json!({"access_token":"renewed","refresh_token":"rotated","expires_in":3600})
            .to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
    });
    let first_owner = Arc::clone(&owner);
    let first = tokio::spawn(async move { first_owner.auth_owner().resolve_codex().await });
    entered_rx.await.unwrap();
    first.abort();
    assert!(first.await.err().unwrap().is_cancelled());
    let mut second = tokio::spawn(async move { owner.auth_owner().resolve_codex().await });
    let early = tokio::time::timeout(Duration::from_millis(100), &mut second).await;
    release_tx.send(()).unwrap();
    server.await.unwrap();
    let result = match early {
        Ok(result) => result.unwrap(),
        Err(_) => second.await.unwrap(),
    };
    assert!(
        matches!(result.unwrap(), crate::models::ProviderAuth::Codex { authorization, .. } if authorization == "Bearer renewed")
    );
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert!(
        saved["refreshToken"] == "rotated",
        "cancelled refresh did not persist the rotated token"
    );
}
