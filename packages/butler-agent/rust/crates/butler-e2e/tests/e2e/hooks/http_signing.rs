//! HTTP hook signatures, the secret's privacy, the transport rule and origin-only logs.
use super::*;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::{fmt::Write as _, path::Path};

/// The receiver's check: HMAC-SHA256 of `<timestamp>.<raw body>`, recent timestamp.
pub(super) fn signature_matches(seen: &Seen, secret: &str) -> bool {
    let timestamp = seen.headers["x-butler-timestamp"].to_str().unwrap();
    let age = chrono::Utc::now().timestamp() - timestamp.parse::<i64>().unwrap();
    assert!(age.abs() < 600, "timestamp {timestamp}");
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(timestamp.as_bytes());
    mac.update(b".");
    mac.update(&seen.raw);
    let mut expected = String::from("sha256=");
    for byte in mac.finalize().into_bytes() {
        write!(expected, "{byte:02x}").unwrap();
    }
    seen.headers["x-butler-signature"].to_str().unwrap() == expected
}

pub(super) async fn save(
    s: &Scenario,
    hooks: Value,
    secrets: Value,
) -> Result<Reply, HarnessError> {
    let current = api(s, Method::GET, "/hooks", None).await?;
    let body = json!({
        "revision": current.data()["revision"],
        "config": {"version": 1, "hooks": hooks},
        "secrets": secrets,
    });
    api(s, Method::PUT, "/hooks", Some(body)).await
}

/// Waits for the sweep that follows a save to delete `secret` from the store.
pub(super) async fn store_loses(s: &Scenario, secret: &str) -> Result<(), HarnessError> {
    let path = s.sandbox.data.join("auth/credential-store.json");
    let deadline = Instant::now() + Duration::from_secs(10);
    while fs::read_to_string(&path)?.contains(secret) {
        assert!(Instant::now() < deadline, "the key was not deleted");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Ok(())
}

/// Every file under `dir` except the credential store and its lock.
fn assert_not_on_disk(dir: &Path, secret: &str) {
    let store = dir.join("auth");
    let mut pending = vec![dir.to_path_buf()];
    while let Some(next) = pending.pop() {
        for entry in fs::read_dir(next).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if !path.starts_with(&store)
                && let Ok(bytes) = fs::read(&path)
            {
                let found = bytes.windows(secret.len()).any(|w| w == secret.as_bytes());
                assert!(!found, "secret in {}", path.display());
            }
        }
    }
}

async fn assert_private(s: &Scenario, secret: &str) -> Result<(), HarnessError> {
    for path in ["/hooks", "/hooks/runs"] {
        let reply = api(s, Method::GET, path, None).await?;
        assert_eq!(reply.status, 200, "{reply:?}");
        assert!(!reply.text.contains(secret), "{path}");
    }
    let logs = s.gw.get("/logs?limit=1000").await?;
    assert!(!logs.text.contains(secret), "logs");
    assert_not_on_disk(&s.sandbox.data, secret);
    Ok(())
}

#[tokio::test]
async fn hooks_http_requests_are_signed_and_the_secret_stays_private() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let endpoint = Endpoint::start().await?;
    let s = setup("HOOK-HTTP-SIGNED")?.start().await?;
    super::super::super::outbound_http::logging(&s, "full").await?;
    let hook = http_hook("signed", "UserPromptSubmit", &endpoint.url("/signed"));

    // Created once and shown once.
    let created = save(&s, json!([hook]), json!({})).await?;
    assert_eq!(created.status, 200, "{created:?}");
    let generated = created.data()["generated_secrets"]["signed"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(generated.len(), 64);
    let again = save(&s, json!([hook]), json!({})).await?;
    assert_eq!(again.status, 200, "{again:?}");
    assert!(again.data().get("generated_secrets").is_none());

    let (_, turn) = s.turn("general", "Signed send.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let seen = endpoint.seen("/signed");
    assert_eq!(seen.len(), 1);
    assert!(signature_matches(&seen[0], &generated));
    assert!(!signature_matches(&seen[0], "another-secret-of-this-size"));
    assert!(!String::from_utf8_lossy(&seen[0].raw).contains(&generated));
    assert_private(&s, &generated).await?;

    // A chosen secret replaces it, is write-only and signs the next request.
    let chosen = "chosen-webhook-secret-value";
    let replaced = save(&s, json!([hook]), json!({"signed": chosen})).await?;
    assert_eq!(replaced.status, 200, "{replaced:?}");
    assert!(!replaced.text.contains(chosen));
    let tested = api(&s, Method::POST, "/hooks/signed/test", Some(json!({}))).await?;
    assert_eq!(tested.data()["outcome"], "continue", "{tested:?}");
    let seen = endpoint.seen("/signed");
    assert!(signature_matches(&seen[1], chosen));
    assert!(!signature_matches(&seen[1], &generated));
    let store = fs::read_to_string(s.sandbox.data.join("auth/credential-store.json"))?;
    assert!(store.contains(chosen), "kept in the credential store");
    store_loses(&s, &generated).await?;
    assert_private(&s, chosen).await?;
    let logs = s.gw.get("/logs?category=http.client&limit=1000").await?;
    assert!(logs.text.contains("hooks.http"), "rows were logged");

    // Refused without echoing the value.
    let weak = "shortvalue";
    let refused = save(&s, json!([hook]), json!({"signed": weak})).await?;
    assert_eq!(refused.error_code(), Some("hook_invalid"), "{refused:?}");
    assert!(!refused.text.contains(weak));
    let elsewhere = save(&s, json!([hook]), json!({"absent": chosen})).await?;
    assert_eq!(
        elsewhere.error_code(),
        Some("hook_invalid"),
        "{elsewhere:?}"
    );
    assert!(!elsewhere.text.contains(chosen));
    let mut inline = hook.clone();
    inline["secret"] = json!(chosen);
    let inline = save(&s, json!([inline]), json!({})).await?;
    assert_eq!(inline.status, 400, "{inline:?}");
    assert!(!inline.text.contains(chosen));

    // Removing the hook removes its secret.
    let removed = save(&s, json!([]), json!({})).await?;
    assert_eq!(removed.status, 200, "{removed:?}");
    store_loses(&s, chosen).await?;
    s.finish().await
}

#[tokio::test]
async fn hooks_http_hand_edited_hook_is_never_sent_unsigned() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let endpoint = Endpoint::start().await?;
    let s = setup("HOOK-HTTP-HAND-EDIT")?.start().await?;
    let hook = http_hook("manual", "Stop", &endpoint.url("/manual"));
    let file = s.sandbox.data.join("hooks.json");

    // A secret in the file is invalid and the error never repeats it.
    let mut inline = hook.clone();
    let secret = "secret-written-into-the-file";
    inline["secret"] = json!(secret);
    fs::write(&file, json!({"version":1,"hooks":[inline]}).to_string())?;
    let settings = api(&s, Method::GET, "/hooks", None).await?;
    assert!(settings.data()["error"].is_string(), "{settings:?}");
    assert!(!settings.text.contains(secret));

    // No secret yet: a failure, and nothing leaves the machine.
    fs::write(&file, json!({"version":1,"hooks":[hook]}).to_string())?;
    let settings = api(&s, Method::GET, "/hooks", None).await?;
    assert!(settings.data()["error"].is_null(), "{settings:?}");
    let tested = api(&s, Method::POST, "/hooks/manual/test", Some(json!({}))).await?;
    assert_eq!(tested.data()["outcome"], "error", "{tested:?}");
    assert!(endpoint.seen("/manual").is_empty());

    // Saving the list unchanged, as Settings does, does not activate the edit.
    let unchanged = save(&s, json!([hook]), json!({})).await?;
    assert_eq!(unchanged.status, 200, "{unchanged:?}");
    assert!(unchanged.data().get("generated_secrets").is_none());
    let tested = api(&s, Method::POST, "/hooks/manual/test", Some(json!({}))).await?;
    assert_eq!(tested.data()["outcome"], "error", "{tested:?}");
    assert!(endpoint.seen("/manual").is_empty());

    // Setting a secret adopts it, and that secret signs.
    let chosen = "secret-the-receiver-was-given";
    let adopted = save(&s, json!([hook]), json!({"manual": chosen})).await?;
    assert_eq!(adopted.status, 200, "{adopted:?}");
    let tested = api(&s, Method::POST, "/hooks/manual/test", Some(json!({}))).await?;
    assert_eq!(tested.data()["outcome"], "continue", "{tested:?}");
    assert!(signature_matches(&endpoint.seen("/manual")[0], chosen));
    s.finish().await
}

#[tokio::test]
async fn hooks_http_plain_http_is_loopback_only() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let endpoint = Endpoint::start().await?;
    let s = setup("HOOK-HTTP-TRANSPORT")?.start().await?;
    for url in [
        "http://hooks.example.com/hook",
        "HTTP://hooks.example.com/hook",
        "http://192.168.0.20/hook", // privacy-hygiene: allow-private-ip (a LAN host is refused)
        "http://0.0.0.0/hook",
        "http://127.0.0.1.example.com/hook",
        "http://localhost.example.com/hook",
        "http://hooks.example.com\\x.localhost/hook",
        "http://[::ffff:8.8.8.8]/hook",
    ] {
        let saved = save(&s, json!([http_hook("plain", "Stop", url)]), json!({})).await?;
        assert_eq!(saved.status, 400, "{url}: {saved:?}");
        assert_eq!(saved.error_code(), Some("hook_invalid"), "{url}");
        assert!(saved.text.contains("https://"), "{url}: {saved:?}");
    }
    for url in [
        "https://hooks.example.com/hook",
        "http://localhost:9/hook",
        "HTTP://LOCALHOST:9/hook",
        "http://127.0.0.1:9/hook",
        "http://127.0.0.2:9/hook",
        "http://[::1]:9/hook",
    ] {
        let saved = save(&s, json!([http_hook("plain", "Stop", url)]), json!({})).await?;
        assert_eq!(saved.status, 200, "{url}: {saved:?}");
    }

    // Accepted at load, refused by the parser that sends: nothing goes out.
    let unsendable = http_hook("plain", "Stop", "http://127.0.0.1:99999/hook");
    let saved = save(&s, json!([unsendable]), json!({})).await?;
    assert_eq!(saved.status, 200, "{saved:?}");
    let tested = api(&s, Method::POST, "/hooks/plain/test", Some(json!({}))).await?;
    assert_eq!(tested.data()["outcome"], "error", "{tested:?}");
    assert_eq!(tested.data()["stderr"], "Hook request failed", "{tested:?}");

    // A hand edit that breaks the rule is refused; the previous registry stays.
    replace(&s, vec![http_hook("kept", "Stop", &endpoint.url("/kept"))]).await?;
    let edited = http_hook("kept", "Stop", "http://hooks.example.com/hook");
    fs::write(
        s.sandbox.data.join("hooks.json"),
        json!({"version":1,"hooks":[edited]}).to_string(),
    )?;
    let settings = api(&s, Method::GET, "/hooks", None).await?;
    let error = settings.data()["error"].as_str().unwrap();
    assert!(error.contains("https://"), "{settings:?}");
    let active = &settings.data()["config"]["hooks"][0]["url"];
    assert_eq!(active, &json!(endpoint.url("/kept")));
    let tested = api(&s, Method::POST, "/hooks/kept/test", Some(json!({}))).await?;
    assert_eq!(tested.data()["outcome"], "continue", "{tested:?}");
    assert_eq!(endpoint.seen("/kept").len(), 1);
    s.finish().await
}

#[tokio::test]
async fn hooks_http_logs_record_only_scheme_and_host() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let endpoint = Endpoint::start().await?;
    let s = setup("HOOK-HTTP-LOG-ORIGIN")?.start().await?;
    super::super::super::outbound_http::logging(&s, "full").await?;
    // Short, letters-only values no credential-shape rule would recognize.
    let (segment, value) = ("zqxjplain", "wvukquery");
    let target = format!("/hook/{segment}?auth={value}");
    let closed = format!("http://127.0.0.1:{}{target}", closed_port());
    for (id, url) in [("reached", endpoint.url(&target)), ("closed", closed)] {
        replace(&s, vec![http_hook(id, "Stop", &url)]).await?;
        let tested = api(
            &s,
            Method::POST,
            &format!("/hooks/{id}/test"),
            Some(json!({})),
        )
        .await?;
        assert_eq!(tested.status, 200, "{tested:?}");
    }
    assert_eq!(endpoint.seen(&format!("/hook/{segment}")).len(), 1);

    let logs = s.gw.get("/logs?limit=1000").await?;
    let rows: Vec<&Value> = logs.data()["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["event"] == "http.request" && row["attrs"]["purpose"] == "hooks.http")
        .collect();
    assert_eq!(rows.len(), 2, "{}", logs.text);
    let success = rows
        .iter()
        .find(|row| row["attrs"]["status"] == 200)
        .unwrap();
    assert!(success["error"].is_null(), "{success}");
    let failure = rows.iter().find(|row| row["error"].is_object()).unwrap();
    assert_eq!(failure["level"], "ERROR", "{failure}");
    assert!(failure["error"]["message"].is_string(), "{failure}");
    for row in [success, failure] {
        assert_eq!(row["attrs"]["scheme"], "http", "{row}");
        assert_eq!(row["attrs"]["host"], "127.0.0.1", "{row}");
        assert!(row["attrs"]["path"].is_null(), "{row}");
        assert!(row["attrs"]["port"].is_null(), "{row}");
    }
    for text in [segment, value] {
        assert!(!logs.text.contains(text), "{text}: {}", logs.text);
    }
    s.finish().await
}
