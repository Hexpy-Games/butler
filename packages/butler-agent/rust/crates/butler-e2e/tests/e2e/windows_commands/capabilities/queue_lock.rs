//! A slow queue write holds no lane another producer needs: a held Allow
//! publication does not delay another chat's message, and a held claim
//! lease does not delay an Allow.
use super::*;
use rusqlite::Connection;
use std::{collections::HashMap, path::PathBuf};

const OTHER: &str = "Reply with one word.";

#[tokio::test]
async fn held_queue_writes_do_not_block_other_producers() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, chat, script, server) = setup(Access::AskAlways).await?;
    let other = session(&s, &chat).await?;
    let pending = s.sandbox.data.join("runtime/inbound-events/pending");

    // The Allow's resume publication stays held while another chat's
    // message is admitted, claimed, run and settled.
    let release = hold(&mut s, "reconstructible_file_publish").await?;
    let (turn, reference) = card(&s, &chat, &script, "held-publication.txt").await?;
    let allow = spawn_allow(&s, &chat, &reference);
    wait_for(&release.with_extension("held")).await?;
    let reply = tokio::time::timeout(Duration::from_secs(10), s.gw.say(&other, OTHER))
        .await
        .expect("message admission waited for the held Allow publication")?;
    s.gw.wait_terminal(&other, &accepted_turn_id(&reply)?, Duration::from_secs(15))
        .await?;
    assert!(
        !allow.is_finished(),
        "the Allow publication was released early"
    );
    std::fs::write(&release, b"release")?;
    let decided = allow.await.unwrap()?;
    assert_eq!(decided.status, 202, "{}", decided.text);
    delivered(&s, &chat, &turn, "held-publication.txt").await?;

    // A claim lease stays held while an Allow publishes its resume.
    let (turn, reference) = card(&s, &chat, &script, "held-claim.txt").await?;
    let release = hold(&mut s, "inbound_claim_staged").await?;
    let reply = s.gw.say(&other, OTHER).await?;
    wait_for(&release.with_extension("held")).await?;
    let decided = tokio::time::timeout(
        Duration::from_secs(10),
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id={chat}"),
            json!({"scope":"once"}),
        ),
    )
    .await
    .expect("the Allow waited for the held claim lease")?;
    assert_eq!(decided.status, 202, "{}", decided.text);
    let resume = pending.join(format!("idempotent-app_resume_{reference}.json"));
    assert!(
        resume.exists(),
        "resume not published while the claim was held"
    );
    std::fs::write(&release, b"release")?;
    s.gw.wait_terminal(&other, &accepted_turn_id(&reply)?, Duration::from_secs(15))
        .await?;
    delivered(&s, &chat, &turn, "held-claim.txt").await?;
    report_lock_waits(&s.agent.logs());
    s.finish().await?;
    server.abort();
    Ok(())
}

/// Restarts the agent with one stub pause at `point`; returns its release file.
async fn hold(s: &mut Scenario, point: &str) -> Result<PathBuf, HarnessError> {
    let release = s.sandbox.root.join(format!("{point}-release"));
    s.agent.terminate().await?;
    s.agent.launch.set_env("BUTLER_E2E_HOLD_POINT", point);
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_RELEASE", release.display().to_string());
    s.gw = s.agent.start_again().await?;
    Ok(release)
}

async fn session(s: &Scenario, chat: &str) -> Result<String, HarnessError> {
    let project: String = Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?
        .query_row("SELECT project_id FROM chats WHERE id=?1", [chat], |r| {
            r.get(0)
        })?;
    let reply =
        s.gw.post("/sessions", json!({"kind":"project","project_id":project}))
            .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["session"]["id"].as_str().unwrap().to_owned())
}

/// A write approval waiting in `chat`, its dispatch already settled.
async fn card(
    s: &Scenario,
    chat: &str,
    script: &provider::Script,
    file: &str,
) -> Result<(String, String), HarnessError> {
    script.select(Case {
        tool: "write_file",
        args: json!({"path":file,"content":"approved","overwrite":false}),
        refused: false,
    });
    let turn = accepted_turn_id(&s.gw.say(chat, provider::PROMPT).await?)?;
    s.gw.wait_turn(chat, &turn, &["waiting_for_form"], Duration::from_secs(15))
        .await?;
    let cards = s.gw.approval_requests(chat).await?;
    assert_eq!(cards.len(), 1);
    let processing = s.sandbox.data.join("runtime/inbound-events/processing");
    let started = Instant::now();
    while std::fs::read_dir(&processing)?.any(|entry| {
        entry.is_ok_and(|entry| entry.file_name().to_string_lossy().ends_with(".json"))
    }) {
        if started.elapsed() > Duration::from_secs(15) {
            return Err(HarnessError("dispatch never settled".into()));
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    Ok((turn, cards[0]["request_ref"].as_str().unwrap().to_owned()))
}

fn spawn_allow(
    s: &Scenario,
    chat: &str,
    reference: &str,
) -> tokio::task::JoinHandle<Result<butler_e2e::e2e::gateway::Reply, HarnessError>> {
    let gw = s.gw.clone();
    let route = format!("/authority-requests/{reference}/allow?session_id={chat}");
    tokio::spawn(async move { gw.post(&route, json!({"scope":"once"})).await })
}

async fn delivered(s: &Scenario, chat: &str, turn: &str, file: &str) -> Result<(), HarnessError> {
    let done =
        s.gw.wait_terminal(chat, turn, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}");
    assert_eq!(
        std::fs::read_to_string(s.sandbox.root.join(file))?,
        "approved"
    );
    Ok(())
}

async fn wait_for(path: &Path) -> Result<(), HarnessError> {
    let started = Instant::now();
    while !path.exists() {
        if started.elapsed() > Duration::from_secs(15) {
            return Err(HarnessError(format!("never reached {}", path.display())));
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    Ok(())
}

/// Prints the longest wait for the queue lane per operation, from the
/// opt-in gateway spans.
fn report_lock_waits(logs: &str) {
    let mut spans: HashMap<(String, String), HashMap<String, u64>> = HashMap::new();
    for line in logs.lines() {
        let Some(rest) = line.strip_prefix("command_gateway_timing ") else {
            continue;
        };
        let field = |name: &str| {
            rest.split(' ')
                .find_map(|part| part.strip_prefix(name))
                .map(str::to_owned)
        };
        let (Some(phase), Some(id), Some(event), Some(elapsed)) = (
            field("phase="),
            field("id="),
            field("event="),
            field("elapsed_us=").and_then(|value| value.parse().ok()),
        ) else {
            continue;
        };
        spans.entry((phase, id)).or_default().insert(event, elapsed);
    }
    for (phase, from) in [
        ("inbound_enqueue", "record_staged"),
        ("inbound_claim", "entry"),
    ] {
        let waits: Vec<u64> = spans
            .iter()
            .filter(|((span, _), _)| span == phase)
            .filter_map(|(_, events)| Some(events.get("lock_acquired")? - events.get(from)?))
            .collect();
        eprintln!(
            "queue_lock_wait phase={phase} count={} max_us={}",
            waits.len(),
            waits.iter().max().copied().unwrap_or(0)
        );
    }
}
