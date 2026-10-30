//! Who receives a signed hook: never a proxy over plain http, and a secret only
//! for the origin it was issued to, even when a save fails.
use super::signing::{save, signature_matches};
use super::*;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// A forward proxy that answers 502 and records every request's first line.
struct Proxy {
    url: String,
    seen: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Proxy {
    async fn start() -> Result<Self, HarnessError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let task = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut bytes = vec![0; 8192];
                let read = stream.read(&mut bytes).await.unwrap_or(0);
                let text = String::from_utf8_lossy(&bytes[..read]);
                let line = text.lines().next().unwrap_or_default().to_owned();
                log.lock().unwrap().push(line);
                let _ = stream
                    .write_all(b"HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n")
                    .await;
            }
        });
        Ok(Self { url, seen, task })
    }
    fn seen(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn test_hook(s: &Scenario, id: &str) -> Result<Value, HarnessError> {
    let path = format!("/hooks/{id}/test");
    let tested = api(s, Method::POST, &path, Some(json!({}))).await?;
    assert_eq!(tested.status, 200, "{tested:?}");
    Ok(tested.data().clone())
}

fn generated(reply: &Reply, id: &str) -> String {
    reply.data()["generated_secrets"][id]
        .as_str()
        .unwrap_or_else(|| panic!("no secret for {id}: {reply:?}"))
        .to_owned()
}

#[tokio::test]
async fn hooks_http_plain_http_never_goes_through_a_proxy() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let endpoint = Endpoint::start().await?;
    let proxy = Proxy::start().await?;
    let mut setup = setup("HOOK-HTTP-PROXY")?;
    for name in ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
        setup = setup.env(name, proxy.url.clone());
    }
    for name in ["NO_PROXY", "no_proxy"] {
        setup = setup.env(name, "");
    }
    let s = setup.start().await?;
    let port = endpoint.base.rsplit(':').next().unwrap();
    let hooks = [
        http_hook("address", "Stop", &endpoint.url("/address")),
        // An uppercase name reaches a loopback listener through the proxy-free
        // client. This cannot show the pin beating a resolver mapping.
        http_hook("name", "Stop", &format!("http://LOCALHOST:{port}/name")),
    ];
    let saved = save(&s, json!(hooks), json!({})).await?;
    assert_eq!(saved.status, 200, "{saved:?}");
    for (id, path) in [("address", "/address"), ("name", "/name")] {
        assert_eq!(test_hook(&s, id).await?["outcome"], "continue");
        let received = endpoint.seen(path);
        assert_eq!(received.len(), 1, "{path}");
        assert!(signature_matches(&received[0], &generated(&saved, id)));
    }
    assert_eq!(proxy.seen(), [] as [String; 0], "the proxy saw plain http");

    // https still uses it, and the proxy sees only where the tunnel goes.
    let tunnel = http_hook("tunnel", "Stop", "https://hooks.example.com/private");
    let saved = save(&s, json!([tunnel]), json!({})).await?;
    assert_eq!(saved.status, 200, "{saved:?}");
    assert_eq!(test_hook(&s, "tunnel").await?["outcome"], "error");
    assert_eq!(proxy.seen().len(), 1, "{:?}", proxy.seen());
    assert!(proxy.seen()[0].starts_with("CONNECT hooks.example.com:443 "));
    s.finish().await
}

#[tokio::test]
async fn hooks_http_secret_is_tied_to_the_receiver_origin() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (first, second) = (Endpoint::start().await?, Endpoint::start().await?);
    let s = setup("HOOK-HTTP-ORIGIN")?.start().await?;
    let at = |url: String| http_hook("moved", "Stop", &url);

    let created = save(&s, json!([at(first.url("/in"))]), json!({})).await?;
    let old = generated(&created, "moved");
    // Another path on the same origin keeps the secret.
    let same = save(&s, json!([at(first.url("/other"))]), json!({})).await?;
    assert!(same.data().get("generated_secrets").is_none(), "{same:?}");

    // A new origin gets a new secret, returned once; the old one no longer signs.
    let moved = save(&s, json!([at(second.url("/in"))]), json!({})).await?;
    let new = generated(&moved, "moved");
    assert_ne!(new, old);
    assert_eq!(test_hook(&s, "moved").await?["outcome"], "continue");
    let received = second.seen("/in");
    assert!(signature_matches(&received[0], &new));
    assert!(!signature_matches(&received[0], &old));

    // A chosen secret for a new origin is used as given.
    let chosen = "chosen-for-the-first-origin";
    let back = save(&s, json!([at(first.url("/in"))]), json!({"moved": chosen})).await?;
    assert_eq!(back.status, 200, "{back:?}");
    assert!(back.data().get("generated_secrets").is_none(), "{back:?}");
    assert_eq!(test_hook(&s, "moved").await?["outcome"], "continue");
    assert!(signature_matches(&first.seen("/in")[0], chosen));

    // A hand edit to another origin never signs with the old secret.
    let file = s.sandbox.data.join("hooks.json");
    let edited = at(second.url("/edited"));
    fs::write(&file, json!({"version":1,"hooks":[edited]}).to_string())?;
    let settings = api(&s, Method::GET, "/hooks", None).await?;
    assert!(settings.data()["error"].is_null(), "{settings:?}");
    let refused = test_hook(&s, "moved").await?;
    assert_eq!(refused["outcome"], "error", "{refused}");
    assert!(refused["stderr"].as_str().unwrap().contains("origin"));
    assert!(second.seen("/edited").is_empty());

    // A hook re-added by hand under a used id gets the same refusal.
    fs::write(&file, json!({"version":1,"hooks":[]}).to_string())?;
    api(&s, Method::GET, "/hooks", None).await?;
    let readded = at(second.url("/readded"));
    fs::write(&file, json!({"version":1,"hooks":[readded]}).to_string())?;
    api(&s, Method::GET, "/hooks", None).await?;
    assert_eq!(test_hook(&s, "moved").await?["outcome"], "error");
    assert!(second.seen("/readded").is_empty());
    s.finish().await
}

#[tokio::test]
async fn hooks_http_failed_save_keeps_the_secret_that_signs() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let endpoint = Endpoint::start().await?;
    let s = setup("HOOK-HTTP-ROLLBACK")?.start().await?;
    let hook = http_hook("kept", "Stop", &endpoint.url("/kept"));
    let first = "the-secret-that-the-receiver-holds";
    let saved = save(&s, json!([hook]), json!({"kept": first})).await?;
    assert_eq!(saved.status, 200, "{saved:?}");

    // The configuration cannot be written: hooks.json is now a directory.
    let file = s.sandbox.data.join("hooks.json");
    fs::remove_file(&file)?;
    fs::create_dir(&file)?;
    let store_path = s.sandbox.data.join("auth/credential-store.json");
    let index_path = s.sandbox.data.join("auth/hook-secrets.json");
    let replacement = "a-secret-from-a-save-that-failed";
    let added = http_hook("added", "Stop", &endpoint.url("/added"));
    let failed = save(&s, json!([hook, added]), json!({"kept": replacement})).await?;
    assert_eq!(failed.error_code(), Some("hook_invalid"), "{failed:?}");
    assert!(
        failed.data().get("generated_secrets").is_none(),
        "{failed:?}"
    );
    let store = fs::read_to_string(&store_path)?;
    assert!(store.contains(first), "the old secret is back");
    assert!(!store.contains(replacement), "the failed one is gone");
    let index: Value = serde_json::from_str(&fs::read_to_string(&index_path)?).unwrap();
    assert!(index["hooks"].get("added").is_none(), "{index}");
    assert!(index["hooks"]["kept"]["origin"].is_string(), "{index}");

    // Once saving works, what the response returns is what signs.
    fs::remove_dir(&file)?;
    let saved = save(&s, json!([hook, added]), json!({})).await?;
    assert_eq!(saved.status, 200, "{saved:?}");
    assert_eq!(test_hook(&s, "added").await?["outcome"], "continue");
    let received = endpoint.seen("/added");
    assert!(signature_matches(&received[0], &generated(&saved, "added")));
    assert_eq!(test_hook(&s, "kept").await?["outcome"], "continue");
    assert!(signature_matches(&endpoint.seen("/kept")[0], first));
    s.finish().await
}

/// Holds the file store's change lock, as a store waiting on someone would.
fn hold_store(s: &Scenario) -> Result<butler_platform::secrets::ChangeLock, HarnessError> {
    let lock = s.sandbox.data.join("auth/credential-store.json.lock");
    Ok(butler_platform::secrets::ChangeLock::acquire(
        &lock,
        Duration::from_secs(5),
    )?)
}

#[tokio::test]
async fn hooks_http_disconnected_save_finishes_and_its_secret_never_signs()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let endpoint = Endpoint::start().await?;
    let s = setup("HOOK-HTTP-DISCONNECT")?.start().await?;
    let seeded = http_hook("seed", "Stop", &endpoint.url("/seed"));
    let saved = save(&s, json!([seeded]), json!({})).await?;
    assert_eq!(saved.status, 200, "{saved:?}");
    let before = saved.data()["revision"].as_u64().unwrap();

    // The client gives up while the store is busy, before any response.
    let lost = http_hook("lost", "Stop", &endpoint.url("/lost"));
    let held = hold_store(&s)?;
    let abandoned = tokio::time::timeout(
        Duration::from_millis(500),
        save(&s, json!([seeded, lost]), json!({})),
    )
    .await;
    assert!(abandoned.is_err(), "the save should still be waiting");
    tokio::time::sleep(Duration::from_millis(200)).await;
    // What a process exit would leave at this point: an entry that cannot sign.
    let index_path = s.sandbox.data.join("auth/hook-secrets.json");
    let index: Value = serde_json::from_slice(&fs::read(&index_path)?).unwrap();
    assert!(index["hooks"]["lost"]["origin"].is_null(), "{index}");
    drop(held);

    // The save still completes as a whole.
    let deadline = Instant::now() + Duration::from_secs(15);
    let settings = loop {
        let settings = api(&s, Method::GET, "/hooks", None).await?;
        if settings.data()["revision"].as_u64().unwrap() > before {
            break settings;
        }
        assert!(Instant::now() < deadline, "the save did not finish");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(settings.data()["config"]["hooks"][1]["id"], "lost");

    // Nobody received its secret, so it does not sign; a retry issues a new one.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let tested = test_hook(&s, "lost").await?;
        if tested["outcome"] == "error" {
            break;
        }
        assert!(Instant::now() < deadline, "the undelivered secret signs");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let delivered_before = endpoint.seen("/lost").len();
    let retried = save(&s, json!([seeded, lost]), json!({})).await?;
    assert_eq!(retried.status, 200, "{retried:?}");
    let secret = generated(&retried, "lost");
    assert_eq!(test_hook(&s, "lost").await?["outcome"], "continue");
    let received = endpoint.seen("/lost");
    assert!(signature_matches(&received[delivered_before], &secret));
    s.finish().await
}

#[tokio::test]
async fn hooks_http_store_refusal_leaves_a_working_hook_working() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let endpoint = Endpoint::start().await?;
    let s = setup("HOOK-HTTP-REFUSAL")?.start().await?;
    let hook = http_hook("kept", "Stop", &endpoint.url("/kept"));
    let first = "the-secret-that-the-receiver-holds";
    let saved = save(&s, json!([hook]), json!({"kept": first})).await?;
    assert_eq!(saved.status, 200, "{saved:?}");
    let index_path = s.sandbox.data.join("auth/hook-secrets.json");
    let index_before = fs::read(&index_path)?;
    let replacement = "a-secret-the-store-never-took";

    // The store refuses the write: its change lock stays busy past the wait.
    let held = hold_store(&s)?;
    let refused = save(&s, json!([hook]), json!({"kept": replacement})).await?;
    drop(held);
    assert_eq!(
        refused.error_code(),
        Some("hook_secret_store_unavailable"),
        "{refused:?}"
    );
    assert_eq!(fs::read(&index_path)?, index_before, "index restored");
    assert_eq!(test_hook(&s, "kept").await?["outcome"], "continue");
    assert!(signature_matches(&endpoint.seen("/kept")[0], first));

    // The store cannot be read: nothing changes, and nothing is deleted.
    let store_path = s.sandbox.data.join("auth/credential-store.json");
    let store_before = fs::read(&store_path)?;
    fs::write(&store_path, b"not json")?;
    let refused = save(&s, json!([hook]), json!({"kept": replacement})).await?;
    assert_eq!(
        refused.error_code(),
        Some("hook_secret_store_unavailable"),
        "{refused:?}"
    );
    assert_eq!(fs::read(&index_path)?, index_before, "index untouched");
    assert_eq!(fs::read(&store_path)?, b"not json", "store untouched");
    fs::write(&store_path, &store_before)?;
    assert_eq!(test_hook(&s, "kept").await?["outcome"], "continue");
    assert!(signature_matches(&endpoint.seen("/kept")[1], first));
    s.finish().await
}
