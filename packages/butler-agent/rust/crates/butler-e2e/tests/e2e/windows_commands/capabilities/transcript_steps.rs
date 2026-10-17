//! A kill after the step sync preserves every pair before publication.
use super::*;

#[tokio::test]
async fn synced_step_recovers_complete_progress_before_approval_publication()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, chat, script, server) = setup(Access::AskAlways).await?;
    s.agent.terminate().await?;
    let release = s.sandbox.root.join("step-release");
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_POINT", "transcript_step_synced");
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_RELEASE", release.display().to_string());
    s.gw = s.agent.start_again().await?;
    let before = s.agent.current_logs().await?.lines().count();
    script.select(Case {
        tool: "write_file",
        args: json!({"path":"step.txt","content":"complete step","overwrite":false}),
        refused: false,
    });
    let id = accepted_turn_id(&s.gw.say(&chat, provider::PROMPT).await?)?;
    let deadline = Instant::now() + Duration::from_secs(15);
    while !release.with_extension("held").exists() {
        assert!(Instant::now() < deadline, "step sync not reached");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let logs = s.agent.current_logs().await?;
    assert_eq!(
        sync_count(&logs.lines().skip(before).collect::<Vec<_>>().join("\n")),
        1
    );
    let db = rusqlite::Connection::open_with_flags(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let projected: u64 = db.query_row(
        "SELECT COALESCE(MAX(projected_bytes),0) FROM app_transcript_projection_checkpoints WHERE chat_id=?1",
        [&chat], |row| row.get(0),
    )?;
    assert_eq!(projected, 0, "projection cannot consume a staged prefix");
    drop(db);
    let (path, bytes) = transcript(&s, &id)?;
    let events = records(&bytes);
    assert!(
        events
            .iter()
            .any(|event| event["payload"]["metadata"]["event"]["kind"] == "tool.completed")
    );
    assert_pairs(&events);
    assert_source_step(&s, &id, &events)?;
    assert!(!s.sandbox.root.join("step.txt").exists());
    s.agent.kill9()?;
    s.agent.launch.remove_env("BUTLER_E2E_HOLD_POINT");
    s.agent.launch.remove_env("BUTLER_E2E_HOLD_RELEASE");
    s.gw = s.agent.start_again().await?;
    let cards = s.gw.approval_requests(&chat).await?;
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0]["source_turn_id"], id);
    assert!(std::fs::read(&path)?.starts_with(&bytes));
    assert_pairs(&records(&std::fs::read(path)?));
    assert!(
        script.result.lock().unwrap().is_none(),
        "no result before approval"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

fn transcript(s: &Scenario, turn: &str) -> Result<(std::path::PathBuf, Vec<u8>), HarnessError> {
    for entry in std::fs::read_dir(s.sandbox.data.join("transcripts"))? {
        let path = entry?.path();
        let bytes = std::fs::read(&path)?;
        if String::from_utf8_lossy(&bytes).contains(turn) {
            return Ok((path, bytes));
        }
    }
    Err(std::io::Error::other("missing step transcript").into())
}

fn assert_source_step(s: &Scenario, turn: &str, events: &[Value]) -> Result<(), HarnessError> {
    let db = rusqlite::Connection::open_with_flags(
        crate::btcc_scale::path(&s.sandbox.data),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let mut statement = db.prepare(
        "SELECT event_id,status FROM btcc_progress_events WHERE turn_id=?1 ORDER BY session_sequence",
    )?;
    let rows = statement.query_map([turn], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut source = Vec::new();
    for row in rows {
        let (id, status) = row?;
        assert_eq!(
            status, "pending",
            "source acknowledgement must follow the boundary"
        );
        source.push(id);
    }
    let written: Vec<_> = events
        .iter()
        .filter(|event| {
            event["kind"] == "outbound" && event["payload"]["metadata"]["turnId"] == turn
        })
        .filter_map(|event| event["payload"]["metadata"]["event"]["id"].as_str())
        .collect();
    assert_ne!(source, [] as [String; 0]);
    assert_eq!(
        written, source,
        "the synced step includes every source event in order"
    );
    Ok(())
}

fn records(bytes: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn assert_pairs(events: &[Value]) {
    assert_eq!(events.len() % 2, 0);
    for pair in events.as_chunks::<2>().0 {
        assert_eq!(pair[0]["kind"], "outbound");
        assert_eq!(pair[1]["kind"], "delivery");
        assert_eq!(
            pair[0]["payload"]["actionId"],
            pair[1]["payload"]["actionId"]
        );
    }
}

pub(super) fn sync_count(logs: &str) -> usize {
    logs.lines()
        .filter(|line| line.contains("phase=transcript_sync ") && line.contains("event=synced "))
        .count()
}

pub(super) fn assert_sample_syncs(logs: &str, access: Access, sample: usize) {
    let count = sync_count(logs);
    let sync_us: u64 = logs
        .lines()
        .filter(|line| line.contains("phase=transcript_sync ") && line.contains("event=synced "))
        .map(|line| {
            line.split_whitespace()
                .find_map(|field| field.strip_prefix("elapsed_us="))
                .unwrap()
                .parse::<u64>()
                .unwrap()
        })
        .sum();
    eprintln!(
        "TRANSCRIPT-SAMPLE access={access:?} sample={sample} syncs={count} sync_us={sync_us}"
    );
    assert_eq!(
        count,
        if access == Access::AskAlways { 3 } else { 2 },
        "one sync per step boundary"
    );
}
