use super::*;

#[tokio::test]
async fn reset_02_requested_survives_kill9() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("RESET-02")?.start().await?;
    let before = generation(&s).await?;
    std::fs::write(s.sandbox.data.join("discard-me"), b"private")?;
    std::fs::create_dir_all(s.sandbox.data.join("outputs"))?;
    std::fs::write(s.sandbox.data.join("outputs/reset-proof"), b"private")?;
    assert_eq!(request(&s, &nonce(&s).await?).await?.status, 202);
    s.agent.kill9()?;
    s.gw = s.agent.start_again().await?;
    assert_ne!(generation(&s).await?, before);
    assert_eq!(
        std::fs::read(s.sandbox.data.join("discard-me"))?,
        b"private"
    );
    assert!(!s.sandbox.data.join("outputs/reset-proof").exists());
    cleaned(&s.sandbox.data).await;
    s.finish().await
}

#[tokio::test]
async fn reset_05_move_failure_rolls_back_and_retries_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for point in ["data_reset.plan", "data_reset.move"] {
        rollback_failure(point).await?;
    }
    Ok(())
}
async fn rollback_failure(point: &str) -> Result<(), HarnessError> {
    let setup = setup("RESET-05")?;
    let marker = setup.sandbox.root.join("move-fault");
    let mut s = setup
        .env("BUTLER_E2E_FILE_FAULT", point)
        .env("BUTLER_E2E_FILE_FAULT_MARKER", marker.display().to_string())
        .start()
        .await?;
    let before = generation(&s).await?;
    std::fs::write(s.sandbox.data.join("discard-me"), b"private")?;
    std::fs::create_dir_all(s.sandbox.data.join("outputs"))?;
    std::fs::write(s.sandbox.data.join("outputs/reset-proof"), b"private")?;
    assert_eq!(request(&s, &nonce(&s).await?).await?.status, 202);
    s.agent.terminate().await?;
    assert!(marker.exists());
    for name in ["discard-me", "outputs/reset-proof"] {
        assert_eq!(std::fs::read(s.sandbox.data.join(name))?, b"private");
    }
    assert_eq!(
        std::fs::read_to_string(s.sandbox.data.join("state/data-generation"))?,
        before.as_str().unwrap()
    );
    // Re-arm the same general fault for the one startup retry.
    std::fs::remove_file(marker)?;
    s.gw = s.agent.start_again().await?;
    assert_eq!(generation(&s).await?, before);
    for name in ["discard-me", "outputs/reset-proof"] {
        assert_eq!(std::fs::read(s.sandbox.data.join(name))?, b"private");
    }
    assert!(!s.sandbox.data.join("state/full-reset.json").exists());
    s.finish().await
}

#[tokio::test]
async fn reset_self_stop_is_a_requested_clean_exit() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("RESET-SELF-STOP")?
        .env("BUTLER_E2E_RESET_STOP_DELAY_MS", "100")
        .start()
        .await?;
    assert_eq!(request(&s, &nonce(&s).await?).await?.status, 202);
    let deadline = Instant::now() + Duration::from_secs(10);
    while s.agent.is_running() {
        assert!(Instant::now() < deadline, "self stop did not exit");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    // Reap and assert the child's requested-stop exit status through the harness.
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    cleaned(&s.sandbox.data).await;
    s.finish().await
}

#[tokio::test]
async fn reset_02_mid_move_kill9_resumes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("RESET-02-MOVE")?;
    let release = setup.sandbox.root.join("move-release");
    let mut s = setup
        .env("BUTLER_E2E_RESET_STOP_DELAY_MS", "100")
        .env("BUTLER_E2E_HOLD_POINT", "data_reset.move")
        .env("BUTLER_E2E_HOLD_RELEASE", release.display().to_string())
        .start()
        .await?;
    let before = generation(&s).await?;
    assert_eq!(request(&s, &nonce(&s).await?).await?.status, 202);
    let deadline = Instant::now() + Duration::from_secs(10);
    while !release.with_extension("held").exists() {
        assert!(Instant::now() < deadline, "apply boundary not reached");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    s.agent.kill9()?;
    std::fs::write(&release, b"release")?;
    s.gw = s.agent.start_again().await?;
    assert_ne!(generation(&s).await?, before);
    cleaned(&s.sandbox.data).await;
    s.finish().await
}

#[tokio::test]
async fn reset_02_abort_before_journal_keeps_old_data() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("RESET-02-BEFORE-JOURNAL")?
        .env("BUTLER_E2E_ABORT_POINT", "data_reset.before_journal")
        .start()
        .await?;
    let before = generation(&s).await?;
    std::fs::write(s.sandbox.data.join("discard-me"), b"private")?;
    std::fs::create_dir_all(s.sandbox.data.join("outputs"))?;
    std::fs::write(s.sandbox.data.join("outputs/reset-proof"), b"private")?;
    let n = nonce(&s).await?;
    assert!(request(&s, &n).await.is_err());
    s.agent.kill9()?;
    s.agent.launch.set_env("BUTLER_E2E_ABORT_POINT", "");
    s.gw = s.agent.start_again().await?;
    assert_eq!(generation(&s).await?, before);
    for name in ["discard-me", "outputs/reset-proof"] {
        assert_eq!(std::fs::read(s.sandbox.data.join(name))?, b"private");
    }
    assert!(!s.sandbox.data.join("state/full-reset.json").exists());
    s.finish().await
}

#[tokio::test]
async fn reset_03_active_and_queued_turns_never_resume() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut cassette = butler_e2e::e2e::cassette::Cassette::load("Q-02")?;
    let prompt = cassette.exchanges[0].request.key.user_request.clone();
    let body = cassette.exchanges[0].response.body();
    cassette.exchanges[0].response.chunks = body
        .split("\n\n")
        .filter(|s| !s.is_empty())
        .enumerate()
        .map(|(i, s)| butler_e2e::e2e::cassette::Chunk {
            delay_ms: if i < 5 { 0 } else { 30_000 },
            text: format!("{s}\n\n"),
        })
        .collect();
    let mut s = setup("RESET-03")?.stub_cassette(cassette).start().await?;
    s.provider()?.set_pacing(butler_e2e::e2e::provider::Pacing {
        scale: 1.0,
        cap_ms: 30_000,
        min_ms: 0,
    });
    let live = butler_e2e::e2e::events::LiveEvents::subscribe(&s.gw, 0).await?;
    let running = s.gw.say_turn("general", &prompt).await?;
    live.wait_for(Duration::from_secs(10), |event| {
        event["type"] == "message.updated"
            && event["payload"]["message"]["turn_id"] == running
            && event["payload"]["message"]["status"] == "streaming"
    })
    .await?;
    drop(live);
    assert_eq!(
        s.provider()?.served(),
        1,
        "stream never reached the provider"
    );
    for text in ["first queued", "second queued"] {
        let queued = s.gw.post("/session-queue", json!({"chat_id":"general","text":text,"client_message_id":uuid::Uuid::new_v4().to_string()})).await?;
        assert_eq!(queued.status, 202, "{}", queued.text);
    }
    assert_eq!(request(&s, &nonce(&s).await?).await?.status, 202);
    let blocked =
        s.gw.post("/messages", json!({"chat_id":"general","text":"blocked"}))
            .await?;
    assert_eq!(blocked.status, 503);
    assert_eq!(blocked.error_code(), Some("service_resetting"));
    let started = Instant::now();
    s.agent.terminate().await?;
    butler_e2e::assert_wall_clock_budget!(
        started.elapsed(),
        Duration::from_secs(8),
        "reset turn shutdown exceeded grace"
    );
    s.gw = s.agent.start_again().await?;
    assert_eq!(s.gw.turns("general").await?, [] as [Value; 0]);
    assert_eq!(s.gw.messages("general").await?, [] as [Value; 0]);
    assert_eq!(s.provider()?.served(), 1, "queued input ran after reset");
    cleaned(&s.sandbox.data).await;
    s.finish().await
}

#[tokio::test]
async fn reset_04_restart_expires_nonce_and_lan_is_refused() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("RESET-04-STALE-LAN")?.start().await?;
    let before = generation(&s).await?;
    let stale = nonce(&s).await?;
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    assert_eq!(request(&s, &stale).await?.status, 400);
    let view = admin(&s).set_remote(true).await?;
    let addresses = view["bind_addresses"].as_array().unwrap();
    assert!(
        addresses.len() > 1,
        "LAN refusal requires a bound LAN listener: {view}"
    );
    for address in addresses.iter().skip(1) {
        let remote = AdminClient::new(
            butler_e2e::e2e::gateway::Gateway::new(
                format!("http://{}", address.as_str().unwrap()),
                s.gw.token.clone(),
            ),
            s.agent.launch.admin_credential().unwrap(),
        );
        for method in [Method::GET, Method::POST] {
            let reply = remote
                .send(method, "/data/reset", Some(json!({})), &[])
                .await?;
            assert_eq!(reply.status, 403, "{}", reply.text);
            assert_eq!(reply.error_code(), Some("loopback_required"));
        }
    }
    admin(&s).set_remote(false).await?;
    assert_eq!(generation(&s).await?, before);
    assert!(!s.sandbox.data.join("state/full-reset.json").exists());
    s.finish().await
}

#[tokio::test]
async fn reset_app_auth_override_is_recreated_after_recovery() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("RESET-APP-AUTH")?;
    let auth = setup
        .sandbox
        .data
        .join("app/runtime/auth/local-agent-auth.json");
    std::fs::create_dir_all(auth.parent().unwrap())?;
    std::fs::write(&auth, json!({"schema":"butler.app-local-agent-auth.v1","product":"butler-app","purpose":"bundled-agent-local-auth","token":"e2e-reset-old-credential-01234567890123456789","created_at":"2026-10-18T00:00:00Z"}).to_string())?;
    let mut s = setup
        .env("BUTLER_APP_LOCAL_AUTH_FILE", auth.display().to_string())
        .start()
        .await?;
    let before = generation(&s).await?;
    let old = s.gw.clone();
    assert_eq!(request(&s, &nonce(&s).await?).await?.status, 202);
    s.agent.kill9()?;
    s.gw = s.agent.start_again().await?;
    assert_ne!(generation(&s).await?, before);
    assert_eq!(old.get("/health").await?.status, 401);
    cleaned(&s.sandbox.data).await;
    s.finish().await
}
