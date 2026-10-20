//! Concurrent foreground mutations and shutdown during real fragmented compaction.
use super::super::memory_response;
use super::{ASK, batch, memory_stubs};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::{
    path::Path,
    time::{Duration, Instant},
};
use tokio::io::AsyncReadExt;

const OLD: &str = "Always end replies with good day.";
const LATEST: &str = "Always format dates as YYYY-MM-DD.";
const SAVE_OLD: &str = "Remember this instruction: always end replies with good day.";
const SAVE_NEW: &str = "Remember this instruction: always format dates as YYYY-MM-DD.";

#[tokio::test]
async fn fragmented_compaction_releases_write_lease_and_cancels_on_shutdown()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (setup, remember, code) = setup()?;
    let release = setup.sandbox.root.join("compact-release");
    let mut s = setup.env("BUTLER_MEMORY_SYNC_TRACE", "1").start().await?;
    assert_eq!(s.turn("general", &remember).await?.1["state"], "delivered");
    memory_stubs::text_complete(&s.sandbox.data, 1).await?;
    let saved = instruction(&s, &format!("The user's bike lock code is {code}.")).await?;
    batch::recall(&s, "general", ASK).await?;
    memory_stubs::vectors_complete(&s.sandbox.data, 2).await?;
    assert_eq!(s.turn("general", SAVE_OLD).await?.1["state"], "delivered");
    memory_stubs::vectors_complete(&s.sandbox.data, 3).await?;
    let old = instruction(&s, OLD).await?;
    s.agent.terminate().await?;
    let seeded = inspect("fragment", &s.sandbox.data).await?;
    assert!(seeded["fragments"].as_u64().unwrap() > 32);
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_POINT", "memory_vector_compact");
    s.agent.launch.set_env(
        "BUTLER_E2E_HOLD_RELEASE",
        release.to_string_lossy().into_owned(),
    );
    s.gw = s.agent.start_again().await?;
    batch::recall(&s, "general", ASK).await?;
    wait_held(&release.with_extension("held")).await?;
    let before = inspect("inspect", &s.sandbox.data).await?;
    assert!(before["fragments"].as_u64().unwrap() > 32);
    // The hold is reached by Lance's remapper after writing replacement files.
    // Foreground owners must acquire the same consolidation lease meanwhile.
    let started = Instant::now();
    assert_eq!(s.turn("general", SAVE_NEW).await?.1["state"], "delivered");
    let latest = instruction(&s, LATEST).await?;
    let write_ms = started.elapsed().as_millis();
    let started = Instant::now();
    let forgotten = s.gw.send(reqwest::Method::DELETE, &format!("/memory/instructions/{}", old["handle"].as_str().unwrap()), Some(json!({"expected_revision":old["revision"], "project_id":null, "operation_id":uuid::Uuid::new_v4().to_string()}).to_string())).await?;
    assert_eq!(forgotten.status, 200, "{}", forgotten.text);
    let forget_ms = started.elapsed().as_millis();
    assert_instructions(&s, &saved, &latest).await?;
    assert!(!release.exists(), "compaction hold was released");
    assert!(!s.agent.current_logs().await?.contains("compact_ms="));
    let started = Instant::now();
    s.agent.terminate().await?;
    let shutdown = started.elapsed();
    butler_e2e::assert_wall_clock_budget!(
        shutdown,
        Duration::from_secs(8),
        "shutdown during compaction"
    );
    assert!(
        !release.exists(),
        "shutdown waited for the hold to be released"
    );
    let stopped = inspect("inspect", &s.sandbox.data).await?;
    assert_eq!(
        stopped, before,
        "cancelled maintenance changed committed rows"
    );
    s.agent.launch.unset_env("BUTLER_E2E_HOLD_POINT");
    s.agent.launch.unset_env("BUTLER_E2E_HOLD_RELEASE");
    s.gw = s.agent.start_again().await?;
    let recalled = batch::recall(&s, "general", ASK).await?;
    // Forget fences the old instruction immediately. Its physical vector is
    // retained until optimize prunes it, so recall reports that stale owner.
    assert_eq!(
        recalled["output"]["coverage"]["vectors"]["state"], "partial",
        "{recalled}"
    );
    assert_eq!(
        recalled["output"]["coverage"]["vectors"]["codes"],
        json!(["vector_current_rows_missing"])
    );
    assert!(
        recalled["output"]["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["channels"]
                .as_array()
                .unwrap()
                .iter()
                .any(|channel| channel == "vector"))
    );
    memory_stubs::vectors_complete(&s.sandbox.data, 6).await?;
    wait_compacted(&s).await?;
    let after = inspect("inspect", &s.sandbox.data).await?;
    for (key, row) in before["rows"].as_object().unwrap() {
        assert_eq!(&after["rows"][key], row, "compaction lost or changed {key}");
    }
    assert_rows_and_latest(&s.sandbox.data, &after)?;
    assert_instructions(&s, &saved, &latest).await?;
    eprintln!(
        "COMPACTION fragments_before={} rows_before={} rows_after={} write_ms={write_ms} forget_ms={forget_ms} shutdown_ms={} held_until_shutdown=true latest_content=true",
        before["fragments"],
        before["row_count"],
        after["row_count"],
        shutdown.as_millis()
    );
    s.finish().await
}

fn setup() -> Result<(Setup, String, String), HarnessError> {
    let (setup, remember, code) = batch::setup("MEM-COMPACTION")?;
    let mut cassette = Cassette::load("MEM-01")?;
    for (prompt, name, arguments) in [
        (ASK, "recall_memory", json!({"cue":"bike lock code"})),
        (
            SAVE_OLD,
            "update_explicit_memory",
            json!({"kind":"instruction", "text":OLD, "source":SAVE_OLD}),
        ),
        (
            SAVE_NEW,
            "update_explicit_memory",
            json!({"kind":"instruction", "text":LATEST, "source":SAVE_NEW}),
        ),
    ] {
        let mut call = cassette.exchanges[0].clone();
        call.request.key.user_request = prompt.into();
        call.response = memory_response(
            &json!({"type":"function_call", "id":"fc_compaction", "call_id":"call_compaction", "name":name, "status":"completed", "arguments":arguments.to_string()}),
        );
        let mut answer = cassette.exchanges[1].clone();
        answer.request.key.user_request = prompt.into();
        cassette.exchanges.extend([call, answer]);
    }
    memory_stubs::extraction(&mut cassette, ASK)?;
    Ok((setup.stub_cassette(cassette), remember, code))
}

async fn instruction(s: &Scenario, text: &str) -> Result<Value, HarnessError> {
    let list = s.gw.get("/memory/instructions").await?;
    assert_eq!(list.status, 200, "{}", list.text);
    Ok(list.data()["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["text"] == text)
        .unwrap_or_else(|| panic!("missing {text}: {}", list.text))
        .clone())
}

async fn assert_instructions(
    s: &Scenario,
    saved: &Value,
    latest: &Value,
) -> Result<(), HarnessError> {
    let list = s.gw.get("/memory/instructions").await?;
    assert_eq!(list.status, 200, "{}", list.text);
    let mut actual = list.data()["instructions"].as_array().unwrap().clone();
    let mut expected = vec![saved.clone(), latest.clone()];
    actual.sort_by_key(|row| row["handle"].as_str().unwrap().to_owned());
    expected.sort_by_key(|row| row["handle"].as_str().unwrap().to_owned());
    assert_eq!(actual, expected);
    Ok(())
}

async fn inspect(command: &str, data: &Path) -> Result<Value, HarnessError> {
    let output = tokio::process::Command::new(butler_e2e::e2e::binary::fixture_binary(
        "e2e-memory-vectors",
    )?)
    .arg(command)
    .arg(data)
    .output()
    .await?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

async fn wait_held(path: &Path) -> Result<(), HarnessError> {
    tokio::time::timeout(Duration::from_secs(90), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("fragmented compaction did not reach its commit boundary");
    Ok(())
}

async fn wait_compacted(s: &Scenario) -> Result<(), HarnessError> {
    let mut log = tokio::fs::File::open(s.sandbox.logs.join("agent-3.log")).await?;
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut appended = String::new();
        loop {
            log.read_to_string(&mut appended).await?;
            if appended.contains("compact_ms=") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        Ok::<_, HarnessError>(())
    })
    .await
    .expect("restart must complete physical compaction")
}

fn assert_rows_and_latest(data: &Path, after: &Value) -> Result<(), HarnessError> {
    let graph = rusqlite::Connection::open_with_flags(
        memory_stubs::graph_path(data)?,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let mut query = graph.prepare("SELECT json_extract(receipt_json,'$.vector_keys[0]'), owner_id, owner_revision, j.revision, projection_text FROM memory_vector_units u JOIN memory_projection_jobs j USING(job_id) WHERE u.state='complete' ORDER BY unit_id")?;
    let rows = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    assert_eq!(
        after["row_count"],
        rows.len() + 33,
        "missing or extra committed vector rows"
    );
    let mut latest = false;
    for (key, owner, revision, source, text) in rows {
        let row = &after["rows"][key];
        assert_eq!(row["owner_id"], owner);
        assert_eq!(row["owner_revision"], revision);
        assert_eq!(row["source_revision"], source);
        latest |= text.contains(SAVE_NEW);
    }
    assert!(
        latest,
        "the write made during compaction was not indexed after restart"
    );
    Ok(())
}
