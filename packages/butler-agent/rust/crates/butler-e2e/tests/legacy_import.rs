//! K. Legacy memory migration and historical imports (SCENARIOS.md MIG-02,
//! MIG-03) on synthetic previous-generation inputs (`fixtures/F3-legacy-*`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_e2e::e2e::{HarnessError, sandbox::copy_tree, sha256_hex};
use serde_json::Value;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(name)
}

/// Relative path + content hash of every file under `root` (empty if absent).
fn tree(root: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.push((
                    path.strip_prefix(root).unwrap().display().to_string(),
                    sha256_hex(&std::fs::read(&path).unwrap_or_default()),
                ));
            }
        }
    }
    out.sort();
    out
}

async fn cli(s: &Scenario, args: &[&str]) -> Result<Value, HarnessError> {
    let output = s.agent.cli_async(args).await?;
    assert_eq!(
        output.code,
        Some(0),
        "{args:?}: {} {}",
        output.stdout,
        output.stderr
    );
    output.json()
}

/// Recall results for `cue` (summaries only, in rank order).
async fn recall(s: &Scenario, cue: &str) -> Result<Vec<String>, HarnessError> {
    let result = cli(s, &["cognition", "memory", "recall", cue, "--json"]).await?;
    Ok(result["data"]["results"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| item["summary"].as_str().unwrap_or_default().to_owned())
        .collect())
}

const RULE_CUE: &str = "greenhouse vents temperature";
const HOT_CUE: &str = "Sungold tomatoes ripen";

fn holds(results: &[String], needle: &str) -> bool {
    results.iter().any(|summary| summary.contains(needle))
}

/// A data dir holding the previous-generation memory root `D/memory`.
fn legacy_memory_setup(id: &str) -> Result<Setup, HarnessError> {
    let setup = Setup::new(id)?;
    copy_tree(
        &fixture("F3-legacy-memory/memory"),
        &setup.sandbox.data.join("memory"),
    )?;
    Ok(setup)
}

/// MIG-02 — Memory migration: status and dry-run write nothing, apply makes
/// the legacy facts recallable, a rerun and a restart change nothing.
#[tokio::test]
async fn mig_02_memory_migration_is_recallable_and_idempotent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = legacy_memory_setup("MIG-02")?.start().await?;
    let legacy = s.sandbox.data.join("memory");
    let migrated = s.sandbox.data.join("cognition/memory");
    let before = tree(&legacy);
    let status = cli(&s, &["cognition", "migrate", "--status", "--json"]).await?;
    assert_eq!(status["data"]["status"], "ready", "{status}");
    assert_eq!(
        status["data"]["legacy_file_count"].as_u64(),
        Some(before.len() as u64),
        "{status}"
    );
    let dry = cli(&s, &["cognition", "migrate", "--dry-run", "--json"]).await?;
    assert_eq!(dry["data"]["dryRun"], true, "{dry}");
    assert_eq!(tree(&legacy), before, "dry-run changed the legacy memory");
    assert!(
        tree(&migrated).is_empty() && !s.sandbox.data.join("cognition/migration").exists(),
        "dry-run wrote migration state"
    );
    assert!(
        recall(&s, RULE_CUE).await?.is_empty(),
        "recalled before migration"
    );

    let applied = cli(&s, &["cognition", "migrate", "--apply", "--json"]).await?;
    assert_eq!(applied["data"]["status"], "applied", "{applied}");
    assert_eq!(
        applied["data"]["moved_paths"].as_array().map(Vec::len),
        Some(1)
    );
    let rule = recall(&s, RULE_CUE).await?;
    assert!(
        holds(&rule, "27 degrees"),
        "legacy rule not recalled: {rule:?}"
    );
    let hot = recall(&s, HOT_CUE).await?;
    assert!(
        holds(&hot, "57 days"),
        "legacy hot cache not recalled: {hot:?}"
    );
    let migrated_tree = tree(&migrated);

    let again = cli(&s, &["cognition", "migrate", "--apply", "--json"]).await?;
    assert_eq!(again["data"]["status"], "applied", "{again}");
    assert_eq!(
        again["data"]["moved_paths"].as_array().map(Vec::len),
        Some(0)
    );
    assert_eq!(
        tree(&migrated),
        migrated_tree,
        "rerun changed the migrated memory"
    );
    assert_eq!(recall(&s, RULE_CUE).await?, rule, "rerun changed recall");

    s.restart().await?;
    assert_eq!(
        recall(&s, RULE_CUE).await?,
        rule,
        "recall changed across restart"
    );
    assert_eq!(recall(&s, HOT_CUE).await?, hot);
    let status = cli(&s, &["cognition", "migrate", "--status", "--json"]).await?;
    assert_eq!(status["data"]["status"], "applied", "{status}");
    s.finish().await
}

/// MIG-02 (inject) — `migrate --apply` killed while it copies the backup;
/// the next apply completes and the legacy facts are recallable once.
#[tokio::test]
#[ignore = "product gap: MIG-02-LOCK — a `cognition migrate --apply` killed mid-copy leaves cognition/migration/namespace-v1.lock; every later apply fails `invalid_state: cognition migration failed: File exists (os error 17)` while `--status` keeps reporting `ready`, so the legacy memory is never migrated"]
async fn mig_02_killed_apply_can_be_rerun() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = legacy_memory_setup("MIG-02-KILL")?;
    // Enough legacy day files that the backup copy takes a moment.
    let filler = "## 09:00 Note\n\n**Chat**: an ordinary day in the garden.\n".repeat(40);
    for day in 0..3000 {
        std::fs::write(
            setup
                .sandbox
                .data
                .join(format!("memory/hot/2020-{day:04}.md")),
            &filler,
        )?;
    }
    let s = setup.start().await?;
    let mut apply = tokio::process::Command::from(s.agent.launch.command());
    apply
        .args(["cognition", "migrate", "--apply", "--json"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = apply.spawn()?;
    let backup = s.sandbox.data.join("cognition/migration/backup");
    let started = Instant::now();
    while std::fs::read_dir(&backup).map_or(0, Iterator::count) == 0 {
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "apply never started its backup"
        );
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    child.start_kill()?;
    child.wait().await?;

    let applied = cli(&s, &["cognition", "migrate", "--apply", "--json"]).await?;
    assert_eq!(applied["data"]["status"], "applied", "{applied}");
    let rule = recall(&s, RULE_CUE).await?;
    assert!(
        holds(&rule, "27 degrees"),
        "legacy rule not recalled: {rule:?}"
    );
    s.finish().await
}

/// Runs `conversation historical-recovery` on the legacy transcript fixture.
async fn recover(s: &Scenario, write: bool) -> Result<Value, HarnessError> {
    let transcript = fixture("F3-legacy-transcript/legacy-garden.jsonl")
        .display()
        .to_string();
    let mut args = vec![
        "conversation",
        "historical-recovery",
        "--transcript-file",
        transcript.as_str(),
    ];
    if write {
        args.push("--write");
    }
    let output = s.agent.cli_async(&args).await?;
    assert_eq!(output.code, Some(0), "{} {}", output.stdout, output.stderr);
    for raw in ["prune the fig tree", "light pruning", "garbled"] {
        assert!(
            !output.stdout.contains(raw) && !output.stderr.contains(raw),
            "report shows raw conversation text"
        );
    }
    output.json()
}

/// MIG-03 — Historical conversation recovery: the dry-run reports counts and
/// writes nothing, the first write imports the clean rows once, a second
/// write imports nothing; malformed and placeholder rows are reported
/// without their text.
#[tokio::test]
async fn mig_03_historical_recovery_imports_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("MIG-03")?.start().await?;
    let dry = recover(&s, false).await?;
    assert_eq!(dry["dry_run"], true, "{dry}");
    let counts = &dry["counts"];
    assert_eq!(counts["total"], 7, "{counts}");
    assert_eq!(counts["admissible"], 4, "{counts}");
    assert_eq!(counts["imported"], 0, "{counts}");
    let reasons: Vec<&str> = dry["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| row["reason"].as_str())
        .collect();
    assert!(
        reasons.contains(&"missing_stable_transcript_identity")
            && reasons.contains(&"transcript_placeholder_or_internal"),
        "malformed and placeholder rows not reported: {reasons:?}"
    );

    let written = recover(&s, true).await?;
    assert_eq!(written["counts"]["imported"], 4, "{written}");
    let again = recover(&s, true).await?;
    assert_eq!(again["counts"]["imported"], 0, "{again}");
    assert_eq!(again["counts"]["skipped_existing"], 4, "{again}");
    s.restart().await?;
    let after = recover(&s, false).await?;
    assert_eq!(
        after["counts"]["skipped_existing"], 4,
        "import lost across restart: {after}"
    );
    s.finish().await
}

/// Pipes the shared third-party export into `args` (the CLI import).
async fn import(s: &Scenario, args: &[&str]) -> Result<Value, HarnessError> {
    let output = s
        .agent
        .cli_async_input(args, Some(butler_e2e::e2e::fixtures::PROFILE_EXPORT))
        .await?;
    assert_eq!(output.code, Some(0), "{} {}", output.stdout, output.stderr);
    output.json()
}

/// MIG-03 — `butler personalization migration import --stdin` imports a
/// third-party export once (the request is the one PRO-02 recorded), a
/// repeat promotes nothing, and bad input is refused.
#[tokio::test]
async fn mig_03_personalization_migration_import() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("MIG-03-PROFILE")?
        .cassette("PRO-02")
        .replay_only()
        .start()
        .await?;
    let enabled =
        s.gw.patch(
            "/personalization",
            serde_json::json!({"profiling": {"mode": "basic"}}),
        )
        .await?;
    assert_eq!(enabled.status, 200, "{}", enabled.text);
    let args = [
        "personalization",
        "migration",
        "import",
        "--stdin",
        "--source",
        "chatgpt",
        "--json",
    ];
    let first = import(&s, &args).await?;
    let data = &first["data"];
    assert_eq!(data["model_called"], true, "{first}");
    assert_eq!(data["raw_text_included"], false, "{first}");
    let entries = data["stable_entry_count"].as_u64().unwrap_or_default();
    assert!(
        entries >= 1 && data["promoted_count"].as_u64() >= Some(1),
        "{first}"
    );
    assert!(
        !first.to_string().contains("Lisbon"),
        "import echoes raw export text"
    );

    let second = import(&s, &args).await?;
    assert_eq!(second["data"]["import_id"], data["import_id"], "{second}");
    assert_eq!(second["data"]["promoted_count"], 0, "{second}");
    assert_eq!(
        second["data"]["stable_entry_count"].as_u64(),
        Some(entries),
        "{second}"
    );

    let empty = s.agent.cli_async_input(&args, Some("")).await?.json()?;
    assert_eq!(empty["data"]["model_called"], false, "{empty}");
    assert_eq!(
        empty["data"]["stable_entry_count"].as_u64(),
        Some(entries),
        "{empty}"
    );
    let unknown = s
        .agent
        .cli_async_input(
            &[
                "personalization",
                "migration",
                "import",
                "--stdin",
                "--bogus",
                "x",
                "--json",
            ],
            Some(butler_e2e::e2e::fixtures::PROFILE_EXPORT),
        )
        .await?;
    assert_ne!(
        unknown.code,
        Some(0),
        "unknown option accepted: {}",
        unknown.stdout
    );
    s.finish().await
}

/// Files a previous generation left for a chat-app gateway that no longer
/// exists, as (path in the data folder, contents). The token is a dummy.
const RETIRED_GATEWAY_FILES: [(&str, &str); 3] = [
    (
        "gateways/telegram.json",
        r#"{"enabled":true,"config":{"botToken":"0000000000:legacy-e2e-dummy","allowedChatIds":[1]}}"#,
    ),
    (
        "auth/telegram-credentials.json",
        r#"{"credentials":[{"kind":"telegram","botToken":"0000000000:legacy-e2e-dummy"}]}"#,
    ),
    (
        "automations/legacy-delivery.json",
        r#"{"id":"legacy","delivery":{"target":"telegram","chatId":1}}"#,
    ),
];

/// MIG-04 — A data folder that still holds a retired chat-app gateway (its
/// settings, credential, a delivery target and a section in
/// `butler.config.json`) starts, passes `doctor`, lists only the `app`
/// gateway, and is left untouched.
#[tokio::test]
async fn mig_04_retired_gateway_files_are_ignored() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("MIG-04")?;
    let data = setup.sandbox.data.clone();
    for (path, body) in RETIRED_GATEWAY_FILES {
        let file = data.join(path);
        std::fs::create_dir_all(file.parent().unwrap())?;
        std::fs::write(file, body)?;
    }
    let mut s = setup.start().await?;
    let config_path = data.join("butler.config.json");
    let mut config: Value = serde_json::from_slice(&std::fs::read(&config_path)?)?;
    config["telegram"] =
        serde_json::json!({"enabled": true, "botToken": "0000000000:legacy-e2e-dummy"});
    config["gateways"] = serde_json::json!({"telegram": {"enabled": true}});
    std::fs::write(&config_path, serde_json::to_vec_pretty(&config)?)?;
    let configured = std::fs::read(&config_path)?;
    s.restart().await?;

    let health = s.gw.get("/health").await?;
    assert_eq!(health.status, 200, "{}", health.text);
    for check in ["data", "credentials"] {
        let doctor = s.agent.cli(&["doctor", "--check", check, "--json"])?;
        assert_eq!(
            doctor.code,
            Some(0),
            "{check}: {} {}",
            doctor.stdout,
            doctor.stderr
        );
    }
    let listed = cli(&s, &["gateway", "list", "--json"]).await?;
    let gateways = listed["data"]["gateways"].as_array().unwrap();
    assert_eq!(gateways.len(), 1, "{listed}");
    assert_eq!(gateways[0]["id"], "app", "{listed}");
    for (path, body) in RETIRED_GATEWAY_FILES {
        assert_eq!(std::fs::read_to_string(data.join(path))?, body, "{path}");
    }
    assert_eq!(std::fs::read(&config_path)?, configured, "config rewritten");
    s.finish().await
}
