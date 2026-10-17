//! A process killed inside a queue write loses, repeats and reorders no
//! message and leaves no staging file: an enqueue synced but not renamed, a
//! settlement synced but not renamed, and a settlement renamed before its
//! directory sync and the release of its claimed copy.
use super::*;
use std::path::PathBuf;

const STATES: [&str; 4] = ["pending", "processing", "processed", "failed"];

/// Kill points with each message's settled record attempts and its turn's
/// outcome. A turn killed before its settlement is durable ends failed and
/// retryable, never run twice (the crash-recovery owner decision).
const POINTS: [(&str, u64, &str); 3] = [
    ("inbound_enqueue_staged", 1, "delivered"),
    ("inbound_settle_staged", 2, "failed"),
    ("inbound_settle_renamed", 1, "delivered"),
];

#[tokio::test]
async fn killed_queue_writes_keep_every_record_once_in_order() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, chat, _script, server) = setup(Access::FullAccess).await?;
    let queue = s.sandbox.data.join("runtime/inbound-events");
    let mut sent = Vec::new();
    for (point, _, _) in POINTS {
        let text = format!("Queue crash at {point}.");
        s.agent.terminate().await?;
        s.agent.launch.set_env("BUTLER_E2E_ABORT_POINT", point);
        s.gw = s.agent.start_again().await?;
        let (gw, target, message) = (s.gw.clone(), chat.clone(), text.clone());
        // An admission killed before its ack fails; the App re-admits it.
        let request = tokio::spawn(async move { gw.say(&target, &message).await });
        wait_exit(&mut s, point).await?;
        let _ = request.await;
        assert_killed_at(&queue, point);
        s.agent.launch.remove_env("BUTLER_E2E_ABORT_POINT");
        s.gw = s.agent.start_again().await?;
        sent.push(text);
        answered(&s, &chat, &sent).await?;
    }
    assert_queue(&queue, &sent);
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn wait_exit(s: &mut Scenario, point: &str) -> Result<(), HarnessError> {
    let started = Instant::now();
    while s.agent.is_running() {
        if started.elapsed() > Duration::from_secs(20) {
            return Err(HarnessError(format!("agent never aborted at {point}")));
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let status = s.agent.reap();
    assert!(status.is_some_and(|status| !status.success()), "{point}");
    Ok(())
}

fn names(queue: &Path, state: &str) -> Vec<String> {
    std::fs::read_dir(queue.join(state)).map_or_else(
        |_| Vec::new(),
        |entries| {
            entries
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect()
        },
    )
}

fn staging(queue: &Path, state: &str) -> Vec<String> {
    names(queue, state)
        .into_iter()
        .filter(|name| name.ends_with(".tmp"))
        .collect()
}

fn records(queue: &Path, state: &str) -> Vec<(PathBuf, Value)> {
    let mut found: Vec<_> = names(queue, state)
        .into_iter()
        .filter(|name| name.ends_with(".json"))
        .map(|name| {
            let path = queue.join(state).join(name);
            let record = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            (path, record)
        })
        .collect();
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

/// The disk state the kill left proves the boundary it interrupted.
fn assert_killed_at(queue: &Path, point: &str) {
    let staged = |state| !staging(queue, state).is_empty();
    match point {
        "inbound_enqueue_staged" => {
            assert!(staged("pending"), "no staged record");
            assert_eq!(records(queue, "pending").len(), 0, "pending");
        }
        "inbound_settle_staged" => {
            assert!(staged("processed"), "no staged settlement");
            let claimed = records(queue, "processing");
            assert_eq!(claimed.len(), 1);
            let name = claimed[0].0.file_name().unwrap();
            assert!(!queue.join("processed").join(name).exists());
        }
        _ => {
            let claimed = records(queue, "processing");
            assert_eq!(claimed.len(), 1, "claimed copy released before the kill");
            let name = claimed[0].0.file_name().unwrap();
            let settled = queue.join("processed").join(name);
            let terminal: Value = serde_json::from_slice(&std::fs::read(settled).unwrap()).unwrap();
            assert_eq!(
                terminal["metadata"]["terminalClaimId"],
                claimed[0].1["processing"]["claimId"]
            );
        }
    }
}

/// Every message sent so far is answered exactly once, in order.
async fn answered(s: &Scenario, chat: &str, sent: &[String]) -> Result<(), HarnessError> {
    let started = Instant::now();
    loop {
        let messages = s.gw.messages(chat).await?;
        let users: Vec<&str> = messages
            .iter()
            .filter(|m| m["role"] == "user")
            .filter_map(|m| m["text"].as_str())
            .collect();
        let answers = messages.iter().filter(|m| m["role"] == "assistant").count();
        let turns = s.gw.turns(chat).await?;
        let states: Vec<_> = turns.iter().map(turn_state).collect();
        let expected: Vec<_> = POINTS[..sent.len()].iter().map(|point| point.2).collect();
        if users == sent && answers == sent.len() && states == expected {
            return Ok(());
        }
        if started.elapsed() > Duration::from_secs(30) {
            let queue = s.sandbox.data.join("runtime/inbound-events");
            let files: Vec<_> = STATES
                .iter()
                .map(|state| (state, names(&queue, state)))
                .collect();
            return Err(HarnessError(format!(
                "sent {sent:?}; users {users:?}; answers {answers}; turns {states:?}; queue {files:?}"
            )));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// One processed record per message, in send order, and nothing else.
fn assert_queue(queue: &Path, sent: &[String]) {
    for state in STATES {
        assert_eq!(staging(queue, state), [] as [String; 0], "{state}");
    }
    assert_eq!(records(queue, "pending").len(), 0, "pending");
    assert_eq!(records(queue, "processing").len(), 0, "processing");
    assert_eq!(records(queue, "failed").len(), 0, "failed");
    let mut processed: Vec<Value> = records(queue, "processed")
        .into_iter()
        .map(|(_, record)| record)
        .collect();
    processed.sort_by_key(|record| record["enqueuedAt"].as_str().unwrap().to_owned());
    let texts: Vec<&str> = processed
        .iter()
        .filter_map(|record| record["envelope"]["message"]["text"].as_str())
        .collect();
    assert_eq!(texts, sent);
    for (record, (_, attempts, _)) in processed.iter().zip(POINTS) {
        let event = record["envelope"]["eventId"].as_str().unwrap();
        let expected = format!("idempotent-{}", event.replace(':', "_"));
        assert_eq!(record["queueId"], expected.as_str());
        assert_eq!(record["attempts"], attempts, "{record}");
    }
}
