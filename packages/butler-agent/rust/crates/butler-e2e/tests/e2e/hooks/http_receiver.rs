//! Who receives a signed hook: never a proxy over plain http, and a secret only
//! for the origin it was issued to, even when a save fails.
use super::signing::{save, signature_matches, store_loses};
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
    let s = setup("HOOK-HTTP-FAILED-SAVE")?.start().await?;
    let hook = http_hook("kept", "Stop", &endpoint.url("/kept"));
    let first = "the-secret-that-the-receiver-holds";
    let saved = save(&s, json!([hook]), json!({"kept": first})).await?;
    assert_eq!(saved.status, 200, "{saved:?}");
    let before = index(&s)?["hooks"]["kept"].clone();

    // The configuration cannot be written: hooks.json is now a directory.
    let file = s.sandbox.data.join("hooks.json");
    fs::remove_file(&file)?;
    fs::create_dir(&file)?;
    let replacement = "a-secret-from-a-save-that-failed";
    let added = http_hook("added", "Stop", &endpoint.url("/added"));
    let failed = save(&s, json!([hook, added]), json!({"kept": replacement})).await?;
    assert_eq!(failed.error_code(), Some("hook_invalid"), "{failed:?}");
    assert!(
        failed.data().get("generated_secrets").is_none(),
        "{failed:?}"
    );
    let after = index(&s)?;
    assert_eq!(
        after["hooks"]["kept"], before,
        "the working entry is untouched"
    );
    assert!(after["hooks"].get("added").is_none(), "{after}");

    // Once saving works, what the response returns is what signs, the hook that
    // was never replaced still signs, and the failed save's keys are gone.
    fs::remove_dir(&file)?;
    let saved = save(&s, json!([hook, added]), json!({})).await?;
    assert_eq!(saved.status, 200, "{saved:?}");
    assert_eq!(test_hook(&s, "added").await?["outcome"], "continue");
    let received = endpoint.seen("/added");
    assert!(signature_matches(&received[0], &generated(&saved, "added")));
    assert_eq!(test_hook(&s, "kept").await?["outcome"], "continue");
    assert!(signature_matches(&endpoint.seen("/kept")[0], first));
    store_loses(&s, replacement).await?;
    s.finish().await
}

fn index(s: &Scenario) -> Result<Value, HarnessError> {
    let path = s.sandbox.data.join("auth/hook-secrets.json");
    Ok(serde_json::from_slice(&fs::read(path)?).unwrap())
}

/// The key this index marks for deletion for `id`, issued for its origin.
fn undelivered(index: &Value, id: &str, origin: &str) -> bool {
    index["orphans"].as_array().unwrap().iter().any(|orphan| {
        orphan["id"] == id
            && orphan["origin"] == origin
            && orphan["key"]
                .as_str()
                .unwrap()
                .starts_with(&format!("{id}."))
    })
}

/// Holds the file store's change lock, as a store waiting on someone would.
fn hold_store(s: &Scenario) -> Result<butler_platform::secrets::ChangeLock, HarnessError> {
    let lock = s.sandbox.data.join("auth/credential-store.json.lock");
    Ok(butler_platform::secrets::ChangeLock::acquire(
        &lock,
        Duration::from_secs(5),
    )?)
}

/// Sends a save that gives up while the store is busy, lets the store go, and
/// waits for it: an invalid save queues behind it and changes nothing.
async fn abandon_save(s: &Scenario, hooks: Value, secrets: Value) -> Result<(), HarnessError> {
    let held = hold_store(s)?;
    let abandoned = tokio::time::timeout(Duration::from_millis(500), save(s, hooks, secrets)).await;
    assert!(abandoned.is_err(), "the save should still be waiting");
    tokio::time::sleep(Duration::from_millis(200)).await;
    drop(held);
    let barrier = save(s, json!([]), json!({"any": "short"})).await?;
    assert_eq!(barrier.error_code(), Some("hook_invalid"), "{barrier:?}");
    Ok(())
}

#[tokio::test]
async fn hooks_http_disconnected_save_changes_nothing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let endpoint = Endpoint::start().await?;
    let s = setup("HOOK-HTTP-DISCONNECT")?.start().await?;
    let seeded = http_hook("seed", "Stop", &endpoint.url("/seed"));
    let saved = save(&s, json!([seeded]), json!({})).await?;
    assert_eq!(saved.status, 200, "{saved:?}");
    let before = saved.data()["revision"].clone();
    let origin = endpoint.base.clone();

    // The client gives up while the store is busy, before any response: no answer
    // means no change, and the key it wrote is only ever marked for deletion.
    let lost = http_hook("lost", "Stop", &endpoint.url("/lost"));
    abandon_save(&s, json!([seeded, lost]), json!({})).await?;
    let settings = api(&s, Method::GET, "/hooks", None).await?;
    assert_eq!(settings.data()["revision"], before, "{settings:?}");
    assert_eq!(
        settings.data()["config"]["hooks"].as_array().unwrap().len(),
        1,
        "{settings:?}"
    );
    let after = index(&s)?;
    assert!(after["hooks"].get("lost").is_none(), "{after}");
    assert!(undelivered(&after, "lost", &origin), "{after}");

    // A hand edit to another origin keeps refusing, even when the list is saved.
    let file = s.sandbox.data.join("hooks.json");
    let elsewhere = Endpoint::start().await?;
    let edited = http_hook("lost", "Stop", &elsewhere.url("/lost"));
    fs::write(
        &file,
        json!({"version":1,"hooks":[seeded, edited]}).to_string(),
    )?;
    let unchanged = save(&s, json!([seeded, edited]), json!({})).await?;
    assert_eq!(unchanged.status, 200, "{unchanged:?}");
    assert!(unchanged.data().get("generated_secrets").is_none());
    assert_eq!(test_hook(&s, "lost").await?["outcome"], "error");
    assert!(elsewhere.seen("/lost").is_empty());
    s.finish().await
}

#[tokio::test]
async fn hooks_http_retry_after_a_disconnect_issues_a_new_secret() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let endpoint = Endpoint::start().await?;
    let s = setup("HOOK-HTTP-RETRY")?.start().await?;
    let seeded = http_hook("seed", "Stop", &endpoint.url("/seed"));
    let saved = save(&s, json!([seeded]), json!({})).await?;
    assert_eq!(saved.status, 200, "{saved:?}");
    let lost = http_hook("lost", "Stop", &endpoint.url("/lost"));
    abandon_save(&s, json!([seeded, lost]), json!({})).await?;
    let abandoned_key = index(&s)?["orphans"][0]["key"].as_str().unwrap().to_owned();

    // The configuration never took the hook, so the retry is a plain addition.
    let retried = save(&s, json!([seeded, lost]), json!({})).await?;
    assert_eq!(retried.status, 200, "{retried:?}");
    let secret = generated(&retried, "lost");
    assert_eq!(test_hook(&s, "lost").await?["outcome"], "continue");
    assert!(signature_matches(&endpoint.seen("/lost")[0], &secret));
    store_loses(&s, &abandoned_key).await?;
    s.finish().await
}

/// Starts from what a process exit between the commit and the promotion leaves: a
/// committed hook with no entry and an orphan marking its undelivered secret.
#[tokio::test]
async fn hooks_http_undelivered_secret_is_issued_again_only_for_its_origin()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let endpoint = Endpoint::start().await?;
    let setup = setup("HOOK-HTTP-UNDELIVERED")?;
    let hooks = [
        http_hook("crashed", "Stop", &endpoint.url("/crashed")),
        http_hook("edited", "Stop", &endpoint.url("/edited")),
        http_hook("replaced", "Stop", &endpoint.url("/replaced")),
    ];
    configure(&setup, &hooks)?;
    let orphan = |id: &str, origin: Value| json!({"id":id,"storage":"fallback_file","key":format!("{id}.seeded"),"origin":origin});
    let auth = setup.sandbox.data.join("auth");
    butler_platform::secure_fs::create_private_dir_all(&auth)?;
    fs::write(
        auth.join("hook-secrets.json"),
        json!({"hooks":{},"orphans":[
            orphan("crashed", json!(endpoint.base)),
            orphan("edited", json!("https://another.example.com")),
            orphan("replaced", Value::Null),
        ]})
        .to_string(),
    )?;
    let s = setup.start().await?;
    assert_eq!(test_hook(&s, "crashed").await?["outcome"], "error");
    assert!(endpoint.seen("/crashed").is_empty());

    // Saving the list unchanged issues only for the matching mark.
    let saved = save(&s, json!(hooks), json!({})).await?;
    assert_eq!(saved.status, 200, "{saved:?}");
    let issued = saved.data()["generated_secrets"].as_object().unwrap();
    assert_eq!(issued.len(), 1, "{saved:?}");
    assert_eq!(test_hook(&s, "crashed").await?["outcome"], "continue");
    let received = endpoint.seen("/crashed");
    assert!(signature_matches(
        &received[0],
        &generated(&saved, "crashed")
    ));
    for id in ["edited", "replaced"] {
        assert_eq!(test_hook(&s, id).await?["outcome"], "error", "{id}");
        assert!(endpoint.seen(&format!("/{id}")).is_empty(), "{id}");
    }

    // The sweep that followed consumed every orphan.
    let deadline = Instant::now() + Duration::from_secs(10);
    while !index(&s)?["orphans"].as_array().unwrap().is_empty() {
        assert!(Instant::now() < deadline, "the orphans were not swept");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    s.finish().await
}

#[tokio::test]
async fn hooks_http_interrupted_save_leaves_a_working_hook_working() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (endpoint, moved_to) = (Endpoint::start().await?, Endpoint::start().await?);
    let mut s = setup("HOOK-HTTP-INTERRUPTED")?.start().await?;
    let hook = http_hook("kept", "Stop", &endpoint.url("/kept"));
    let first = "the-secret-that-the-receiver-holds";
    let saved = save(&s, json!([hook]), json!({"kept": first})).await?;
    assert_eq!(saved.status, 200, "{saved:?}");
    let before = saved.data()["revision"].clone();
    let entry = index(&s)?["hooks"]["kept"].clone();

    // Rotating a secret, the client leaves: no change, the old secret keeps signing.
    let lost = "a-secret-from-a-client-that-left";
    abandon_save(&s, json!([hook]), json!({"kept": lost})).await?;
    let settings = api(&s, Method::GET, "/hooks", None).await?;
    assert_eq!(settings.data()["revision"], before, "{settings:?}");
    assert_eq!(index(&s)?["hooks"]["kept"], entry);
    assert_eq!(test_hook(&s, "kept").await?["outcome"], "continue");
    assert!(signature_matches(&endpoint.seen("/kept")[0], first));

    // The process is killed with `stage` blocked in `put`, so nothing is committed:
    // the hook keeps its old URL, and nothing changed for the old receiver.
    let target = http_hook("kept", "Stop", &moved_to.url("/kept"));
    let held = hold_store(&s)?;
    let abandoned = tokio::time::timeout(
        Duration::from_millis(500),
        save(&s, json!([target]), json!({})),
    )
    .await;
    assert!(abandoned.is_err(), "the save should still be waiting");
    // Mid-write, the new key is already listed for deletion and nothing else moved.
    let during = index(&s)?;
    assert!(undelivered(&during, "kept", &moved_to.base), "{during}");
    assert_eq!(during["hooks"]["kept"], entry);
    s.agent.kill9()?;
    drop(held);
    s.gw = s.agent.start_again().await?;
    assert_eq!(index(&s)?["hooks"]["kept"], entry);
    assert_eq!(test_hook(&s, "kept").await?["outcome"], "continue");
    assert!(signature_matches(&endpoint.seen("/kept")[1], first));
    assert!(moved_to.seen("/kept").is_empty());

    // Retrying that move issues a new secret, and only then does it take effect.
    let moved = save(&s, json!([target]), json!({})).await?;
    assert_eq!(moved.status, 200, "{moved:?}");
    assert_eq!(test_hook(&s, "kept").await?["outcome"], "continue");
    let received = moved_to.seen("/kept");
    assert!(signature_matches(&received[0], &generated(&moved, "kept")));
    store_loses(&s, first).await?;
    store_loses(&s, lost).await?;
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
    let entry = index(&s)?["hooks"]["kept"].clone();
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
    assert_eq!(index(&s)?["hooks"]["kept"], entry);
    assert_eq!(test_hook(&s, "kept").await?["outcome"], "continue");
    assert!(signature_matches(&endpoint.seen("/kept")[0], first));

    // The store cannot be read or written: the same, and the store is untouched.
    let store_path = s.sandbox.data.join("auth/credential-store.json");
    let store_before = fs::read(&store_path)?;
    fs::write(&store_path, b"not json")?;
    let refused = save(&s, json!([hook]), json!({"kept": replacement})).await?;
    assert_eq!(
        refused.error_code(),
        Some("hook_secret_store_unavailable"),
        "{refused:?}"
    );
    assert_eq!(index(&s)?["hooks"]["kept"], entry);
    assert_eq!(fs::read(&store_path)?, b"not json", "store untouched");
    fs::write(&store_path, &store_before)?;
    assert_eq!(test_hook(&s, "kept").await?["outcome"], "continue");
    assert!(signature_matches(&endpoint.seen("/kept")[1], first));
    s.finish().await
}
