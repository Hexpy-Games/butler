//! Stub E2E: proactive, resumable model acquisition through setup/status.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
#[path = "embed_download_support/mod.rs"]
mod embed_download_support;
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Fixture, Setup},
};
use embed_download_support::{Server, choose, model_until, snapshot};
use std::{sync::atomic::Ordering, time::Duration};

#[tokio::test]
async fn stub_rejects_real_model_sources_before_network_or_retry() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for source in [
        "",
        "https://huggingface.co/Xenova/bge-m3/resolve/main",
        "https://github.com/Hexpy-Games/butler/releases/download/models-bge-m3-4de13258",
    ] {
        let s = Setup::new("EMBED-STUB-GUARD")?
            .fixture(Fixture::Empty)
            .env("BUTLER_E2E_EMBED_SOURCES", source)
            .start()
            .await?;
        choose(&s.gw, true).await?;
        let started = std::time::Instant::now();
        let failed = model_until(&s.gw, "failed").await?;
        assert_eq!(
            failed["reason"],
            "embed_asset_real_download_forbidden_in_stub"
        );
        assert_eq!(failed["bytes_done"], 0);
        eprintln!(
            "EMBED-STUB-GUARD failed_after_ms={} bytes_done=0",
            started.elapsed().as_millis()
        );
        assert!(s.agent.logs().contains("BUTLER_E2E_TIER=stub requires"));
        let root = s.sandbox.data.join("cache/models/Xenova/bge-m3");
        assert!(
            snapshot(&root)?
                .iter()
                .all(|(path, _, _)| !path.ends_with(".part"))
        );
        s.finish().await?;
    }
    Ok(())
}

#[test]
fn offline_status_reads_partial_progress_without_model_writes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut setup = Setup::new("EMBED-OFFLINE")?;
    let root = setup.sandbox.data.join("cache/models/Xenova/bge-m3");
    let staging = root.join(".native-embedding-acquire");
    std::fs::create_dir_all(&staging)?;
    std::fs::write(staging.join("tokenizer.json.part"), b"partial")?;
    let before = snapshot(&root)?;
    let launch = butler_e2e::e2e::agent::Launch::new(&setup.sandbox)?;
    let output = launch.command().args(["status", "--json"]).output()?;
    assert!(output.status.success());
    let view: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    assert_eq!(view["data"]["memoryModel"]["state"], "queued");
    assert_eq!(view["data"]["memoryModel"]["bytes_done"], 7);
    assert_eq!(view["data"]["memoryModel"]["bytes_total"], 586_779_294_u64);
    assert_eq!(before, snapshot(&root)?);
    setup.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn background_progress_resume_mirror_and_idle() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = Server::start().await;
    server.pause.store(true, Ordering::SeqCst);
    let mut s = Setup::new("EMBED-DOWNLOAD")?
        .fixture(Fixture::Empty)
        .env("BUTLER_E2E_EMBED_MANIFEST", server.manifest())
        .start()
        .await?;
    choose(&s.gw, true).await?;
    let downloading = model_until(&s.gw, "downloading").await?;
    assert!(downloading["bytes_done"].as_u64().unwrap() > 0);
    assert_eq!(downloading["bytes_total"], server.total());
    assert_eq!(s.gw.get("/runtime-readiness").await?.status, 200);
    let status = s.agent.cli_async(&["status", "--json"]).await?;
    assert_eq!(
        status.json()?["data"]["memoryModel"]["state"],
        "downloading"
    );
    s.agent.kill9()?;
    let root = s.sandbox.data.join("cache/models/Xenova/bge-m3");
    let partial = root.join(".native-embedding-acquire/tokenizer.json.part");
    let offset = usize::try_from(std::fs::metadata(&partial)?.len()).expect("small fixture offset");
    assert!(offset > 0 && offset < 256 * 1024);
    assert!(!root.join("tokenizer.json").exists());
    server.pause.store(false, Ordering::SeqCst);
    s.gw = s.agent.start_again().await?;
    let ready = model_until(&s.gw, "ready").await?;
    assert_eq!(ready["bytes_done"], server.total());
    assert!(
        server.ranges.load(Ordering::SeqCst) > 0,
        "restart must send Range"
    );
    assert_eq!(server.offsets.lock().unwrap()[0], offset);
    assert!(
        server.primary.load(Ordering::SeqCst) >= 4,
        "primary tried first"
    );
    assert!(server.mirror.load(Ordering::SeqCst) >= 4, "404 falls back");
    let status = s.agent.cli_async(&["status", "--json"]).await?;
    assert_eq!(status.json()?["data"]["memoryModel"]["state"], "ready");
    for file in [
        "tokenizer.json",
        "tokenizer_config.json",
        "config.json",
        "onnx/model_quantized.onnx",
    ] {
        assert_eq!(std::fs::read(root.join(file))?, vec![42; 256 * 1024]);
    }
    let before = snapshot(&root)?;
    let requests = server.requests();
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(before, snapshot(&root)?, "ready has no model disk writes");
    assert_eq!(requests, server.requests(), "ready has no network");
    s.restart().await?;
    model_until(&s.gw, "ready").await?;
    assert_eq!(
        before,
        snapshot(&root)?,
        "complete cache untouched on restart"
    );
    assert_eq!(requests, server.requests());
    s.finish().await
}

#[tokio::test]
async fn corrupt_assets_fail_verification_without_publication() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = Server::start().await;
    server.corrupt.store(true, Ordering::SeqCst);
    let s = Setup::new("EMBED-HASH")?
        .fixture(Fixture::Empty)
        .env("BUTLER_E2E_EMBED_MANIFEST", server.manifest())
        .start()
        .await?;
    super::outbound_http::logging(&s, "detailed").await?;
    choose(&s.gw, true).await?;
    let failed = model_until(&s.gw, "failed").await?;
    assert_eq!(failed["reason"], "embed_asset_hash_mismatch");
    assert_eq!(server.requests(), 6);
    let root = s.sandbox.data.join("cache/models/Xenova/bge-m3");
    assert!(!root.join("tokenizer.json").exists());
    assert!(
        !root
            .join(".native-embedding-acquire/tokenizer.json.part")
            .exists()
    );
    let rows = super::outbound_http::http_calls(&s, &server.address).await?;
    assert_eq!(rows.len(), server.requests());
    let mut retries: Vec<_> = rows
        .iter()
        .map(|row| row["attrs"]["retry"].as_u64().unwrap())
        .collect();
    retries.sort_unstable();
    assert_eq!(retries, [0, 1, 2, 3, 4, 5]);
    s.finish().await
}

#[tokio::test]
async fn failure_is_bounded_and_retry_preserves_chat_readiness() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = Server::start().await;
    server.fail_all.store(true, Ordering::SeqCst);
    let s = Setup::new("EMBED-RETRY")?
        .fixture(Fixture::Empty)
        .env("BUTLER_E2E_EMBED_MANIFEST", server.manifest())
        .start()
        .await?;
    choose(&s.gw, true).await?;
    let failed = model_until(&s.gw, "failed").await?;
    assert_eq!(failed["reason"], "embed_asset_download_failed");
    assert_eq!(server.requests(), 6, "three attempts per source, then stop");
    let status = s.agent.cli_async(&["status", "--json"]).await?;
    assert_eq!(status.json()?["data"]["memoryModel"]["state"], "failed");
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(server.requests(), 6, "failure has no busy retry loop");
    server.fail_all.store(false, Ordering::SeqCst);
    server.primary_ok.store(true, Ordering::SeqCst);
    let retried =
        s.gw.post(
            "/setup/readiness/retry",
            serde_json::json!({"memory_model_only": true}),
        )
        .await?;
    assert_eq!(
        retried.data()["status"],
        "ready",
        "memory retry never gates setup"
    );
    model_until(&s.gw, "ready").await?;
    assert_eq!(
        server.mirror.load(Ordering::SeqCst),
        3,
        "healthy primary needs no mirror"
    );
    s.finish().await
}

#[tokio::test]
async fn chat_works_while_memory_model_downloads() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = Server::start().await;
    server.primary_ok.store(true, Ordering::SeqCst);
    server.pause.store(true, Ordering::SeqCst);
    let cassette = butler_e2e::e2e::cassette::Cassette::load("TURN-01")?;
    let prompt = cassette.exchanges[0].request.key.user_request.clone();
    let expected = cassette.exchanges[0].response.output_text();
    let s = Setup::new("EMBED-CHAT")?
        .stub_cassette(cassette)
        .env("BUTLER_E2E_EMBED_MANIFEST", server.manifest())
        .start()
        .await?;
    choose(&s.gw, true).await?;
    model_until(&s.gw, "downloading").await?;
    let (_, turn) = s.turn("general", &prompt).await?;
    assert_eq!(butler_e2e::e2e::gateway::turn_state(&turn), "delivered");
    let messages = s.gw.messages("general").await?;
    assert!(
        messages
            .iter()
            .any(|message| message["role"] == "assistant" && message["text"] == expected)
    );
    assert_ne!(
        s.gw.get("/setup/readiness").await?.data()["memory_model"]["state"],
        "ready"
    );
    s.finish().await
}

fn stored_choice(data: &std::path::Path) -> Option<String> {
    let config: serde_json::Value =
        serde_json::from_slice(&std::fs::read(data.join("butler.config.json")).ok()?).ok()?;
    config["memory"]["embeddings"].as_str().map(str::to_owned)
}

#[tokio::test]
async fn fresh_profile_downloads_only_after_the_choice() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = Server::start().await;
    server.primary_ok.store(true, Ordering::SeqCst);
    let mut s = Setup::new("EMBED-CHOICE")?
        .fixture(Fixture::Empty)
        .env("BUTLER_E2E_EMBED_MANIFEST", server.manifest())
        .start()
        .await?;
    let unset = s.gw.get("/setup/readiness").await?.data()["memory_model"].clone();
    assert_eq!(unset["state"], "unset");
    assert_eq!(
        unset["bytes_total"], 586_779_294_u64,
        "the choice can show the size"
    );
    let status = s.agent.cli_async(&["status", "--json"]).await?;
    assert_eq!(status.json()?["data"]["memoryModel"]["state"], "unset");
    tokio::time::sleep(Duration::from_secs(2)).await;
    let root = s.sandbox.data.join("cache/models/Xenova/bge-m3");
    assert_eq!(server.requests(), 0, "unset never downloads");
    assert!(!root.exists());
    assert_eq!(choose(&s.gw, false).await?["state"], "off");
    assert_eq!(stored_choice(&s.sandbox.data).as_deref(), Some("off"));
    s.restart().await?;
    let off = s.gw.get("/setup/readiness").await?.data()["memory_model"].clone();
    assert_eq!(off["state"], "off", "the choice survives restart");
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(server.requests(), 0, "off never downloads");
    assert!(!root.exists());
    choose(&s.gw, true).await?;
    model_until(&s.gw, "ready").await?;
    assert_eq!(
        server.requests(),
        4,
        "one request per file after the choice"
    );
    assert_eq!(stored_choice(&s.sandbox.data).as_deref(), Some("on"));
    eprintln!(
        "EMBED-CHOICE unset=0 off=0 on={} requests",
        server.requests()
    );
    s.finish().await
}
