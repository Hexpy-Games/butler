//! E. Memory write & recall (SCENARIOS.md MEM-01..04).
//!
//! Recall needs the local BGE-M3 embedding model (570 MB, pinned Hugging Face
//! revision). The harness installs it from `BUTLER_E2E_EMBEDDING_ASSETS`;
//! without it these scenarios report `SKIPPED (embedding assets)`. The e2e
//! workflow fetches and caches the pinned files.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::faults::{Fault, Transform};
use butler_e2e::e2e::gateway::{tool_rows, turn_state};
use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_e2e::e2e::{HarnessError, fixtures, live, nonce};
use serde_json::Value;

async fn cli_json(s: &Scenario, args: &[&str]) -> Result<Value, HarnessError> {
    s.agent.cli_async(args).await?.json()
}

async fn session_hint(s: &Scenario, chat: &str) -> Result<String, HarnessError> {
    let sessions = s.gw.get("/sessions").await?;
    Ok(sessions.data()["sessions"]
        .as_array()
        .and_then(|list| list.iter().find(|session| session["id"] == chat))
        .and_then(|session| session["session_hint"].as_str())
        .unwrap_or(chat)
        .to_owned())
}

fn recalled(result: &Value, needle: &str) -> bool {
    result["data"]["results"].to_string().contains(needle)
}

/// MEM-02 — Conversation ingest makes a past chat recallable, across restart.
#[tokio::test]
#[ignore = "product gap: MEM-02-INBOUND — App chat user messages are not written to the session transcript, so `butler cognition memory ingest --session` summarizes only Butler's replies: the recorded ingest prompt holds just `butler: Understood.`, the model's summary of it is empty, ingest saves nothing (savedChunks 0, warning legacy_hot_summary_failed) and the fact the user stated is not recallable"]
async fn mem_02_conversation_ingest_is_recallable() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let code = nonce();
    let setup = Setup::new("MEM-02")?
        .cassette("MEM-02")
        .placeholder("NONCE", &code);
    if !fixtures::embedding_assets(&setup.sandbox.data)? {
        live::report(
            "MEM-02",
            "SKIPPED (embedding assets: set BUTLER_E2E_EMBEDDING_ASSETS)",
        );
        return Ok(());
    }
    let mut s = setup.start().await?;
    let (_, turn) = s
        .turn(
            "general",
            &format!(
                "For my garden notes: the greenhouse door code is {code}. Just acknowledge briefly."
            ),
        )
        .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let hint = session_hint(&s, "general").await?;
    let ingest = cli_json(
        &s,
        &[
            "cognition",
            "memory",
            "ingest",
            "--session",
            &hint,
            "--json",
        ],
    )
    .await?;
    assert_eq!(ingest["ok"], true, "{ingest}");
    let cue = "greenhouse door code";
    let result = recall(&s, cue).await?;
    assert!(
        recalled(&result, &code),
        "ingested fact not recalled: {result}"
    );
    s.restart().await?;
    let result = recall(&s, cue).await?;
    assert!(
        recalled(&result, &code),
        "recall lost across restart: {result}"
    );
    s.finish().await
}

async fn recall(s: &Scenario, cue: &str) -> Result<Value, HarnessError> {
    cli_json(s, &["cognition", "memory", "recall", cue, "--json"]).await
}

/// MEM-01 — A fact the user asks Butler to remember is written by the
/// explicit memory tool, recallable, and survives a restart; the tool result
/// shows no private paths or internal job ids. (The spec's forget half —
/// `cognition box forget`, `box rebuild-index` — follows once a memory can be
/// written from a chat at all.)
#[tokio::test]
#[ignore = "product gap: MEM-01-WRITE — in an App chat the explicit memory tool is outside the session's tool surface: tool_search lists update_explicit_memory with enabled:false (`outside the current session's scoped progressive surface`; only a session binding that already carries the memory-write profile gets it), so asking Butler to remember a fact writes nothing and recall returns no result. The MEM-01 cassette is that real exchange (the model answers that the memory tool is unavailable); re-record it once fixed"]
async fn mem_01_remember_and_recall() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let code = nonce();
    let setup = Setup::new("MEM-01")?
        .cassette("MEM-01")
        .placeholder("NONCE", &code);
    fixtures::embedding_assets(&setup.sandbox.data)?;
    let mut s = setup.start().await?;
    let (turn_id, turn) = s
        .turn(
            "general",
            &format!(
                "Please save this as a durable explicit memory so you remember it in future conversations: my bike lock code is {code}. Use your explicit memory tool, then confirm in one short sentence."
            ),
        )
        .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let rows = tool_rows(&s.gw.messages("general").await?, &turn_id);
    let write = rows
        .iter()
        .find(|row| {
            row.to_string().contains("update_explicit_memory") && row["state"] == "delivered"
        })
        .unwrap_or_else(|| panic!("no delivered explicit memory write: {rows:#?}"));
    let output = s.gw.operation_output(&turn_id, write).await?;
    let root = s.sandbox.root.display().to_string();
    assert!(
        !output.contains(&root),
        "memory tool result shows a private path: {output}"
    );
    assert!(
        !output.contains("job_id"),
        "memory tool result shows a job id: {output}"
    );

    let result = recall(&s, "bike lock code").await?;
    assert!(
        recalled(&result, &code),
        "remembered fact not recalled: {result}"
    );
    s.restart().await?;
    let result = recall(&s, "bike lock code").await?;
    assert!(
        recalled(&result, &code),
        "recall lost across restart: {result}"
    );
    s.finish().await
}

const FIG_CUE: &str = "prune the fig tree";

async fn memory_status(s: &Scenario) -> Result<Value, HarnessError> {
    let status = cli_json(s, &["cognition", "memory", "status", "--json"]).await?;
    assert_eq!(status["ok"], true, "{status}");
    Ok(status["data"].clone())
}

/// A data dir whose memory holds an ingested legacy conversation (the
/// F3-legacy transcript) with its vector index built by `memory maintain`.
async fn indexed_memory(id: &str, replay_only: bool) -> Result<Option<Scenario>, HarnessError> {
    let mut setup = Setup::new(id)?.cassette("MEM-03");
    if replay_only {
        setup = setup.replay_only();
    }
    if !fixtures::embedding_assets(&setup.sandbox.data)? {
        live::report(
            id,
            "SKIPPED (embedding assets: set BUTLER_E2E_EMBEDDING_ASSETS)",
        );
        return Ok(None);
    }
    let transcripts = setup.sandbox.data.join("transcripts");
    std::fs::create_dir_all(&transcripts)?;
    std::fs::copy(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/F3-legacy-transcript/telegram-garden.jsonl"),
        transcripts.join("telegram_dm-garden.jsonl"),
    )?;
    let s = setup.start().await?;
    let ingest = cli_json(
        &s,
        &[
            "cognition",
            "memory",
            "ingest",
            "--session",
            "telegram/dm-garden",
            "--json",
        ],
    )
    .await?;
    assert_eq!(ingest["data"]["savedChunks"], 1, "{ingest}");
    let maintain = cli_json(&s, &["cognition", "memory", "maintain", "--json"]).await?;
    assert_eq!(maintain["ok"], true, "{maintain}");
    let rows = memory_status(&s).await?["vectorRowCount"]
        .as_f64()
        .unwrap_or_default();
    assert!(rows >= 1.0, "no vector index after maintain");
    assert!(recalled(&recall(&s, FIG_CUE).await?, "late winter"));
    Ok(Some(s))
}

fn vector_index(s: &Scenario) -> std::path::PathBuf {
    s.sandbox.data.join("cognition/memory/db/butler.lance")
}

/// MEM-03 — With the vector index deleted, recall still answers from the
/// lexical memory, chat turns are unaffected, and `memory maintain`
/// rebuilds the index with recall intact.
#[tokio::test]
async fn mem_03_missing_vector_index_degrades_then_repairs() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Some(s) = indexed_memory("MEM-03", false).await? else {
        return Ok(());
    };
    assert!(vector_index(&s).is_dir(), "vector index not where expected");
    std::fs::remove_dir_all(vector_index(&s))?;

    let degraded = recall(&s, FIG_CUE).await?;
    assert!(
        recalled(&degraded, "late winter"),
        "recall lost the fact: {degraded}"
    );
    let (_, turn) = s
        .turn("general", "Reply with exactly: memory check")
        .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");

    let repair = cli_json(&s, &["cognition", "memory", "maintain", "--json"]).await?;
    assert_eq!(repair["ok"], true, "{repair}");
    let backfill = &repair["data"]["hotCacheVectorBackfill"];
    assert!(
        backfill["indexed"].as_u64() >= Some(1) && backfill["failed"] == 0,
        "{repair}"
    );
    assert!(
        vector_index(&s).is_dir(),
        "maintain did not rebuild the index"
    );
    let status = memory_status(&s).await?;
    assert!(status["vectorRowCount"].as_f64() >= Some(1.0), "{status}");
    assert!(recalled(&recall(&s, FIG_CUE).await?, "late winter"));
    s.finish().await
}

/// MEM-03 — `memory status` reports a missing vector index.
#[tokio::test]
#[ignore = "product gap: MEM-03-STATUS — after the vector index (cognition/memory/db/butler.lance) is deleted, `butler cognition memory status` still reports the old vectorRowCount (read from db/vector-stats.json) and no diagnostic about the missing index"]
async fn mem_03_status_reports_missing_vector_index() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Some(s) = indexed_memory("MEM-03-STATUS", true).await? else {
        return Ok(());
    };
    std::fs::remove_dir_all(vector_index(&s))?;
    let status = memory_status(&s).await?;
    let rows = status["vectorRowCount"].as_f64();
    let diagnosed = status["diagnostics"]
        .to_string()
        .to_lowercase()
        .contains("vector");
    assert!(
        diagnosed && rows.is_none_or(|rows| rows == 0.0),
        "missing index not reported: vectorRowCount {rows:?}, diagnostics {}",
        status["diagnostics"]
    );
    s.finish().await
}

async fn consolidate(s: &Scenario) -> Result<Value, HarnessError> {
    let run = cli_json(
        s,
        &["cognition", "consolidation", "run", "--manual", "--json"],
    )
    .await?;
    assert_eq!(run["ok"], true, "{run}");
    Ok(run["data"].clone())
}

fn phase<'a>(run: &'a Value, name: &str) -> &'a Value {
    run["phases"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|phase| phase["phase"] == name)
        .unwrap_or_else(|| panic!("no {name} phase: {run}"))
}

async fn briefing(s: &Scenario) -> Result<Value, HarnessError> {
    let reply = s.gw.get("/new-chat-briefing").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data()["source"].clone())
}

/// Briefing artifacts the consolidation keeps (one directory per day).
fn briefing_files(s: &Scenario) -> Vec<String> {
    let root = s.sandbox.data.join("cognition/consolidation/briefings");
    let mut files = Vec::new();
    for day in std::fs::read_dir(&root).into_iter().flatten().flatten() {
        for file in std::fs::read_dir(day.path())
            .into_iter()
            .flatten()
            .flatten()
        {
            files.push(format!(
                "{}/{}",
                day.file_name().to_string_lossy(),
                file.file_name().to_string_lossy()
            ));
        }
    }
    files.sort();
    files
}

/// MEM-04 — A manual consolidation run completes and publishes the
/// new-chat briefing it generated; a rerun replaces it (one artifact per
/// day, no duplicates) and a restart keeps it.
#[tokio::test]
async fn mem_04_consolidation_run_completes_and_reruns() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("MEM-04")?.cassette("MEM-04").start().await?;
    assert_eq!(briefing(&s).await?["content_origin"], "heuristic_fallback");
    let mut last = String::new();
    for round in ["first run", "rerun"] {
        let run = consolidate(&s).await?;
        assert_eq!(run["status"], "completed", "{round}: {run}");
        let brief = &phase(&run, "new_chat_briefing")["metrics"];
        assert_eq!(brief["generated_count"], 1, "{round}: {brief}");
        assert_eq!(brief["failed_count"], 0, "{round}: {brief}");
        let shown = briefing(&s).await?;
        assert_eq!(shown["content_origin"], "generated", "{round}: {shown}");
        assert_eq!(
            shown["consolidation_run_id"], run["run_id"],
            "{round}: {shown}"
        );
        assert_eq!(
            briefing_files(&s).len(),
            1,
            "{round}: {:?}",
            briefing_files(&s)
        );
        last = run["run_id"].as_str().unwrap().to_owned();
    }
    s.restart().await?;
    let shown = briefing(&s).await?;
    assert_eq!(
        shown["consolidation_run_id"],
        last.as_str(),
        "briefing lost across restart"
    );
    s.finish().await
}

/// MEM-04 (inject) — a run killed (SIGKILL) while it waits for the model
/// leaves consolidation usable: status answers and a rerun completes.
#[tokio::test]
async fn mem_04_killed_run_can_rerun() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("MEM-04-KILL")?
        .cassette("MEM-04")
        .replay_only()
        .start()
        .await?;
    let provider = s.provider()?;
    provider.inject(Fault::on_request(
        "general_new_chat_briefing",
        0,
        Transform::StallAfter(0),
    ))?;
    let served = provider.served();
    let mut run = tokio::process::Command::from(s.agent.launch.command());
    run.args(["cognition", "consolidation", "run", "--manual", "--json"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = run.spawn()?;
    let started = std::time::Instant::now();
    while provider.served() == served {
        assert!(
            started.elapsed() < std::time::Duration::from_secs(60),
            "the run never asked the model"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    child.start_kill()?;
    child.wait().await?;

    let status = cli_json(&s, &["cognition", "consolidation", "status", "--json"]).await?;
    assert_eq!(status["ok"], true, "{status}");
    let rerun = consolidate(&s).await?;
    assert_eq!(rerun["status"], "completed", "{rerun}");
    let shown = briefing(&s).await?;
    assert_eq!(shown["consolidation_run_id"], rerun["run_id"], "{shown}");
    assert_eq!(briefing_files(&s).len(), 1, "{:?}", briefing_files(&s));
    s.finish().await
}
