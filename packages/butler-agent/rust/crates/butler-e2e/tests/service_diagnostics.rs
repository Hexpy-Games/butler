//! Fresh startup model, complete operational export and zero idle service writes.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    fixtures,
    scenario::{Fixture, Setup},
    stop_intent::{StopOnDrop, instance_record},
};
use butler_platform::process_control::usage;
use serde_json::json;
use std::{fs, io::Write, time::Duration};

#[tokio::test]
async fn fresh_service_uses_routine_model_and_it_runs_a_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut cassette = Cassette::load("Q-02")?;
    cassette.meta.model = "openai/gpt-6.1-sol".into();
    cassette.meta.effort = Some("medium".into());
    for exchange in &mut cassette.exchanges {
        exchange.request.key.model = "gpt-6.1-sol".into();
        exchange.request.key.effort = Some("medium".into());
        for chunk in &mut exchange.response.chunks {
            chunk.text = chunk.text.replace("gpt-6-sol", "gpt-6.1-sol");
        }
    }

    let mut alias = Cassette::load("Q-02")?.exchanges.remove(1);
    alias.request.key.model = "gpt-5.5".into();
    alias.request.key.effort = Some("medium".into());
    for chunk in &mut alias.response.chunks {
        chunk.text = chunk.text.replace("gpt-6-sol", "gpt-5.5");
    }
    cassette.exchanges.push(alias);
    let setup = Setup::new("FRESH-ROUTINE-MODEL")?
        .fixture(Fixture::Empty)
        .stub_cassette(cassette);
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data, fixtures::FIXTURE_TIME)?;
    let s = setup.start().await?;
    assert!(
        s.agent
            .logs()
            .contains("[native-butler] ready model=openai/gpt-6.1-sol"),
        "{}",
        s.agent.logs()
    );
    assert!(!s.agent.logs().contains("ready model=openai/gpt-5.5-codex"));
    let catalog = s.gw.get("/model-catalog").await?;
    assert!(
        !catalog
            .text
            .contains("\"model_ref\":\"openai/gpt-5.5-codex\"")
    );
    s.gw.patch("/settings", json!({"model":"openai/gpt-6.1-sol","reasoning_effort":"medium","access_mode":"full_access"})).await?;
    let (_, turn) = s
        .turn("general", "Reply with exactly the word: waiting")
        .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    assert_eq!(s.provider()?.requests()[0]["model"], "gpt-6.1-sol");
    let retired =
        s.gw.patch("/settings", json!({"model":"openai/gpt-5.5-codex"}))
            .await?;
    // This legacy alias is normalized by App settings before the provider call.
    assert_eq!(retired.status, 200, "{}", retired.text);
    assert_eq!(retired.data()["model"], "openai/gpt-5.5");
    let (_, alias_turn) = s
        .turn("general", "Reply with exactly the word: waiting")
        .await?;
    assert_eq!(alias_turn["state"], "delivered", "{alias_turn}");
    assert_eq!(s.provider()?.requests()[1]["model"], "gpt-5.5");
    s.finish().await
}

#[tokio::test]
async fn cli_logs_export_safe_summary_and_have_zero_idle_writes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SERVICE-LOG-EXPORT")?
        .stub_cassette(Cassette::load("Q-02")?)
        .start()
        .await?;
    s.agent.terminate().await?;
    let cleanup = StopOnDrop(s.agent.launch.clone());
    let start = s.agent.cli_async(&["start", "--json"]).await?;
    assert_eq!(start.code, Some(0), "{start:?}");
    let (_, turn) = s
        .turn("general", "Reply with exactly the word: waiting")
        .await?;
    assert_eq!(turn["state"], "delivered");
    let messages = s.gw.messages("general").await?;
    tokio::time::sleep(Duration::from_secs(5)).await;
    let record = instance_record(&s.sandbox.data).unwrap();
    let pids = [
        u32::try_from(record["pid"].as_u64().unwrap()).unwrap(),
        u32::try_from(record["cli_supervisor_pid"].as_u64().unwrap()).unwrap(),
    ];
    let before_files = stamps(&s.sandbox.data)?;
    let before = pids.map(|pid| usage::sample(pid).unwrap());
    tokio::time::sleep(Duration::from_secs(10)).await;
    let after = pids.map(|pid| usage::sample(pid).unwrap());
    for i in 0..2 {
        if let (Some(before), Some(after)) = (&before[i], &after[i]) {
            let bytes = after.write_bytes - before.write_bytes;
            let chars = after
                .write_chars
                .zip(before.write_chars)
                .map(|(a, b)| a - b);
            eprintln!(
                "idle pid={} window=10s write_bytes={bytes} write_chars={chars:?}",
                pids[i]
            );
            assert_eq!(bytes, 0, "idle service storage writes");
            // Linux wchar includes Tokio eventfd notifications. Disk files,
            // including buffered logs and SQLite WALs, are checked below.
        }
    }
    let after_files = stamps(&s.sandbox.data)?;
    assert_eq!(after_files, before_files, "idle buffered file writes");
    eprintln!("idle window=10s modified_files=0 log_bytes_written=0");
    assert_eq!(
        s.gw.messages("general").await?,
        messages,
        "idle changed session content"
    );
    let stop = s.agent.cli_async(&["stop", "--json"]).await?;
    assert_eq!(stop.code, Some(0), "{stop:?}");
    let stderr = s.sandbox.data.join("logs/butler-agent-service.stderr.log");
    fs::OpenOptions::new().append(true).open(&stderr)?.write_all(
        b"2026-10-02T00:00:00Z [native-app] unavailable token=fixture-secret Bearer fixture-bearer\nprivate conversation content\n2026-10-02T00:00:00Z [native-model] prompt=private conversation content\n")?;
    let export = s
        .agent
        .cli_async(&["doctor", "--collect-logs", "--json"])
        .await?;
    assert_eq!(export.code, Some(0), "{export:?}");
    let exported = export.json()?;
    let bundle = std::path::Path::new(exported["data"]["bundle"].as_str().unwrap());
    let summary = fs::read_to_string(bundle.join("summary.txt"))?;
    for text in [
        "Version:",
        "OS:",
        "Install kind:",
        "Service manager present:",
        "Last 5 exits",
        "code=requested_stop",
        "Last error:",
    ] {
        assert!(summary.contains(text), "{summary}");
    }
    for name in [
        "butler-agent-service.stderr.log",
        "butler-agent-service.stdout.log",
        "summary.txt",
    ] {
        let text = fs::read_to_string(bundle.join(name))?;
        assert!(
            !text.contains("fixture-secret")
                && !text.contains("fixture-bearer")
                && !text.contains("private conversation content"),
            "{name}"
        );
        if name.ends_with(".log") {
            for line in text.lines() {
                assert!(
                    chrono::DateTime::parse_from_rfc3339(line.split_whitespace().next().unwrap())
                        .is_ok(),
                    "{line}"
                );
            }
        }
    }
    drop(cleanup);
    s.finish().await
}

fn stamps(
    root: &std::path::Path,
) -> Result<
    std::collections::BTreeMap<std::path::PathBuf, (u64, std::time::SystemTime)>,
    HarnessError,
> {
    let mut files = std::collections::BTreeMap::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            files.extend(stamps(&entry.path())?);
        } else {
            let metadata = entry.metadata()?;
            files.insert(entry.path(), (metadata.len(), metadata.modified()?));
        }
    }
    Ok(files)
}
