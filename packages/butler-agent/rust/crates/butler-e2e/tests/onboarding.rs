//! A. First run / onboarding (SCENARIOS.md ONB-01..04).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::Duration;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::agent::Launch;
use butler_e2e::e2e::fixtures;
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::scenario::{Fixture, Setup};
use serde_json::json;

/// ONB-01 — Fresh install boots to a usable, empty state.
#[tokio::test]
async fn onb_01_fresh_install_boots_empty() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("ONB-01")?.fixture(Fixture::Empty);
    let installation = setup.sandbox.installation_fingerprint()?;
    let mut s = setup.start().await?;
    let health = s.gw.get("/health").await?;
    assert_eq!(health.data()["ok"], true);
    assert_eq!(health.data()["protocol_version"], "butler.app.v1");
    assert_eq!(s.gw.get("/runtime-readiness").await?.status, 200);
    let settings = s.gw.settings().await?;
    assert!(
        settings["language"].is_string() && settings["timezone"].is_string(),
        "{settings}"
    );
    let model = settings["model"].as_str().unwrap_or_default().to_owned();
    let catalog = s.gw.get("/model-catalog").await?;
    let listed = catalog.data()["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|provider| provider["models"].as_array().cloned().unwrap_or_default())
        .find(|entry| entry["model_ref"] == model.as_str());
    let listed = listed.unwrap_or_else(|| panic!("default model {model} not in catalog"));
    assert_eq!(listed["runtime_supported"], true, "{listed}");
    let chats = s.gw.get("/chats").await?;
    for chat in chats.data().as_array().unwrap() {
        assert!(
            s.gw.messages(chat["id"].as_str().unwrap())
                .await?
                .is_empty(),
            "fresh chat has messages"
        );
    }
    assert_eq!(s.gw.get("/navigation").await?.status, 200);
    let status = s.agent.cli(&["status", "--json"])?;
    assert_eq!(status.code, Some(0), "{}", status.stderr);
    assert_eq!(status.json()?["ok"], true);
    s.agent.terminate().await?;
    assert!(!s.agent.is_running());
    assert_eq!(
        s.sandbox.installation_fingerprint()?,
        installation,
        "installation dir changed"
    );
    s.gw = s.agent.start_again().await?;
    s.finish().await
}

/// ONB-01 (inject) — unusable data dirs are refused before any write.
#[tokio::test]
async fn onb_01_unusable_data_dirs_are_refused() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("ONB-01-INJECT")?.fixture(Fixture::Empty);
    // (a) data dir not writable.
    let locked = setup.sandbox.root.join("locked-data");
    std::fs::create_dir_all(&locked)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o500))?;
    }
    let mut launch = Launch::new(&setup.sandbox)?;
    launch.data = locked.clone();
    let output = launch
        .command()
        .stdin(std::process::Stdio::null())
        .output()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700))?;
    }
    assert!(!output.status.success(), "started on a read-only data dir");
    assert_eq!(
        std::fs::read_dir(&locked)?.count(),
        0,
        "partial files in the read-only data dir"
    );
    // (b) data dir inside the installation dir.
    let inside = setup.sandbox.install.join("data");
    std::fs::create_dir_all(&inside)?;
    let before = setup.sandbox.installation_fingerprint()?;
    let mut launch = Launch::new(&setup.sandbox)?;
    launch.data = inside.clone();
    let output = launch
        .command()
        .stdin(std::process::Stdio::null())
        .output()?;
    assert!(
        !output.status.success(),
        "started with the data dir inside the installation"
    );
    let after = setup.sandbox.installation_fingerprint()?;
    assert_eq!(after, before, "writes into the installation dir");
    Ok(())
}

/// ONB-02 — First message without any provider credential.
#[tokio::test]
async fn onb_02_first_message_without_credential_fails_clearly() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("ONB-02")?
        .cassette("ONB-02")
        .without_credential()
        .start()
        .await?;
    if s.recording() {
        s.turn("general", "Reply with exactly the word: connected")
            .await?;
        return s.finish().await;
    }
    let (turn_id, turn) = s
        .turn("general", "Reply with exactly the word: connected")
        .await?;
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    let messages = s.gw.messages("general").await?;
    assert!(
        !messages
            .iter()
            .any(|m| m["role"] == "assistant" && m["status"] == "delivered"),
        "{messages:?}"
    );
    let text = s.gw.get("/messages?chat_id=general").await?.text
        + &s.gw.get("/turns?chat_id=general").await?.text;
    let lowered = text.to_lowercase();
    assert!(
        lowered.contains("auth")
            || lowered.contains("credential")
            || lowered.contains("sign in")
            || lowered.contains("connect"),
        "no auth-required error visible: {text}"
    );
    assert!(
        !text.contains(&s.sandbox.home.display().to_string()),
        "private path in the public error"
    );
    assert!(s.gw.healthy().await);
    assert_eq!(
        s.provider()?.served(),
        0,
        "a request reached the provider without credentials"
    );
    let _ = turn_id;

    // Connect the provider (the Codex sign-in file appears) and send again.
    fixtures::stub_codex_auth(&s.sandbox.codex_home())?;
    let (_, turn) = s
        .turn("general", "Reply with exactly the word: connected")
        .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    s.finish().await
}

/// ONB-04 — The gateway requires its token.
#[tokio::test]
async fn onb_04_gateway_requires_its_token() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("ONB-04")?
        .env("BUTLER_APP_SERVER_MESSAGE_RATE_LIMIT_MAX", "3")
        .start()
        .await?;
    let before = s.gw.get("/settings").await?.text;
    for token in [None, Some("wrong-token")] {
        for (method, path, body) in [
            (reqwest::Method::GET, "/settings", None),
            (
                reqwest::Method::PATCH,
                "/settings",
                Some(json!({"language": "ko"}).to_string()),
            ),
            (
                reqwest::Method::POST,
                "/messages",
                Some(json!({"text": "hi"}).to_string()),
            ),
            (reqwest::Method::GET, "/events/live", None),
        ] {
            let reply =
                s.gw.send_with(method.clone(), path, body, token, &[])
                    .await?;
            assert_eq!(
                reply.status, 401,
                "{method} {path} with {token:?}: {}",
                reply.text
            );
            assert!(
                reply.error_code().is_some(),
                "no public error envelope: {}",
                reply.text
            );
            assert!(!reply.text.contains(&s.gw.token));
        }
    }
    assert_eq!(
        s.gw.get("/settings").await?.text,
        before,
        "rejected call changed state"
    );
    assert!(s.gw.messages("general").await?.is_empty());

    let preflight =
        s.gw.raw(
            reqwest::Method::OPTIONS,
            "/settings",
            &[
                ("origin", "https://evil.example"),
                ("access-control-request-method", "PATCH"),
            ],
        )
        .await?;
    assert!(
        preflight
            .headers()
            .get("access-control-allow-origin")
            .is_none(),
        "foreign origin allowed"
    );

    let mut statuses = Vec::new();
    for index in 0..6 {
        let reply = s
            .gw
            .post("/messages", json!({"chat_id": "burst", "text": format!("burst {index}"), "client_message_id": uuid::Uuid::new_v4().to_string()}))
            .await?;
        statuses.push(reply.status);
        if reply.status == 429 {
            assert_eq!(reply.error_code(), Some("rate_limited"), "{}", reply.text);
        }
    }
    assert!(
        statuses.contains(&429),
        "no rate limit on burst: {statuses:?}"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(s.gw.healthy().await);
    s.finish().await
}

/// ONB-02 (inject) — credential present, provider answers the recorded real
/// 401: same user-facing class, bounded, no retry storm.
#[tokio::test]
async fn onb_02_provider_401_fails_without_retry_storm() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    use butler_e2e::e2e::faults::{Fault, Transform};
    let s = Setup::new("ONB-02-401")?
        .cassette("ONB-02")
        .replay_only()
        .start()
        .await?;
    let exchange = s.provider()?.exchange_for("connected", 0)?;
    s.provider()?.inject(Fault::always(
        exchange,
        Transform::ErrorFromLibrary("codex-401".into()),
    ))?;
    let started = std::time::Instant::now();
    let (_, turn) = s
        .turn("general", "Reply with exactly the word: connected")
        .await?;
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    assert!(
        started.elapsed() < Duration::from_secs(30),
        "401 not terminal in time: {:?}",
        started.elapsed()
    );
    assert!(
        s.provider()?.served() <= 3,
        "retry storm: {} provider calls",
        s.provider()?.served()
    );
    let text = s.gw.get("/messages?chat_id=general").await?.text
        + &s.gw.get("/turns?chat_id=general").await?.text;
    let lowered = text.to_lowercase();
    assert!(
        lowered.contains("auth") || lowered.contains("sign in") || lowered.contains("credential"),
        "401 not reported as an authentication problem: {text}"
    );
    assert!(
        !text.contains("e2e-replay-placeholder"),
        "credential leaked into the public error"
    );
    assert!(s.gw.healthy().await);
    s.finish().await
}

/// ONB-03 — The language the installer passes (first-run setup sends
/// `PATCH /settings {language}`) becomes the UI language and survives a
/// restart; `butler config get user.language` agrees.
#[tokio::test]
async fn onb_03_installer_language_persists() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("ONB-03")?
        .fixture(Fixture::Empty)
        .start()
        .await?;
    let reply = s.gw.patch("/settings", json!({"language": "ko"})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(reply.data()["language"], "ko", "{}", reply.text);
    s.restart().await?;
    let settings = s.gw.settings().await?;
    assert_eq!(settings["language"], "ko", "{settings}");
    let cli = s.agent.cli(&["config", "get", "user.language", "--json"])?;
    assert_eq!(cli.code, Some(0), "{} {}", cli.stdout, cli.stderr);
    assert!(
        cli.stdout.contains("\"ko\""),
        "CLI disagrees: {}",
        cli.stdout
    );
    s.finish().await
}

/// ONB-03 — The installer language also sets the answer language.
#[tokio::test]
#[ignore = "product gap: ONB-03-LANG — `PATCH /settings {language:\"ko\"}` (what first-run setup sends) stores only user.language: GET /personalization keeps response_language \"en\", and `butler personalization get user.responseLanguage --json` ignores the key and prints the profile without any response language"]
async fn onb_03_installer_language_sets_response_language() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("ONB-03")?
        .fixture(Fixture::Empty)
        .start()
        .await?;
    let reply = s.gw.patch("/settings", json!({"language": "ko"})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    for phase in ["before restart", "after restart"] {
        let personalization = s.gw.get("/personalization").await?;
        assert_eq!(
            personalization.data()["response_language"],
            "ko",
            "{phase}: {}",
            personalization.text
        );
        let cli = s
            .agent
            .cli(&["personalization", "get", "user.responseLanguage", "--json"])?;
        assert_eq!(cli.code, Some(0), "{phase}: {} {}", cli.stdout, cli.stderr);
        assert_eq!(
            cli.json()?["data"]["value"],
            "ko",
            "{phase}: {}",
            cli.stdout
        );
        if phase == "before restart" {
            s.restart().await?;
        }
    }
    s.finish().await
}
