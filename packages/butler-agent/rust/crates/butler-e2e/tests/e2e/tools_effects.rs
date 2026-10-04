//! D. Tool execution with effects (SCENARIOS.md TOOL-02, TOOL-06, TOOL-07).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use butler_e2e::e2e::gateway::{TERMINAL, tool_rows, turn_state};
use butler_e2e::e2e::scenario::{Scenario, Setup, accepted_turn_id};
use butler_e2e::e2e::{HarnessError, nonce};
use serde_json::{Value, json};

async fn send(s: &Scenario, text: &str, access_mode: &str) -> Result<String, HarnessError> {
    let accepted =
        s.gw.send_message(
            json!({"chat_id": "general", "text": text, "access_mode": access_mode,
            "client_message_id": uuid::Uuid::new_v4().to_string()}),
        )
        .await?;
    accepted_turn_id(&accepted)
}

/// TOOL-02 — write then edit change the file exactly; read-only refuses.
#[tokio::test]
async fn tool_02_write_edit_and_read_only() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let marker = nonce();
    let s = Setup::new("TOOL-02")?
        .cassette("TOOL-02")
        .placeholder("NONCE", &marker)
        .start()
        .await?;
    let prompt = format!(
        "Create out.txt in your workspace containing exactly `alpha {marker}`, then use edit_file to change alpha to beta."
    );
    let turn_id = send(&s, &prompt, "full_access").await?;
    let turn =
        s.gw.wait_terminal(
            "general",
            &turn_id,
            Duration::from_secs(butler_e2e::e2e::scenario::turn_timeout()),
        )
        .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let out = s.sandbox.data.join("out.txt");
    assert_eq!(
        fs::read_to_string(&out)?.trim_end(),
        format!("beta {marker}")
    );
    let rows = tool_rows(&s.gw.messages("general").await?, &turn_id);
    assert!(
        rows.iter()
            .any(|row| row["safe_tool_name"] == "edit_file" && row["state"] == "delivered"),
        "{rows:?}"
    );

    let ro_prompt = format!("Create ro.txt in your workspace containing exactly `gamma {marker}`.");
    let requests = s.provider()?.requests();
    super::token_metrics::report(&s, &requests, "write/edit replay")?;
    super::token_cache::verify_write_edit(&s, &requests, &rows, &turn_id, &marker).await?;
    let turn_id = send(&s, &ro_prompt, "read_only").await?;
    let turn =
        s.gw.wait_terminal(
            "general",
            &turn_id,
            Duration::from_secs(butler_e2e::e2e::scenario::turn_timeout()),
        )
        .await?;
    assert!(
        matches!(turn_state(&turn), "delivered" | "failed"),
        "read-only turn: {turn}"
    );
    assert!(
        !s.sandbox.data.join("ro.txt").exists(),
        "read-only mode wrote a file"
    );
    assert_eq!(
        fs::read_to_string(&out)?.trim_end(),
        format!("beta {marker}"),
        "read-only turn changed out.txt"
    );
    s.finish().await
}

/// TOOL-06 — a command past its timeout is stopped with its whole process tree.
#[tokio::test]
async fn tool_06_command_timeout_kills_the_process_tree() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::POSIX_SHELL,
        "this scenario replays commands recorded for a POSIX shell; the Windows shell is covered by butler-turn tests"
    );
    let s = Setup::new("TOOL-06")?.cassette("TOOL-06").start().await?;
    let prompt = "Use run_command with timeout_ms 3000 to run exactly: sh -c 'sleep 300 & echo $! > pids.txt; echo $$ >> pids.txt; sleep 300'. Then tell me what happened.";
    let (turn_id, turn) = s.turn("general", prompt).await?;
    assert!(TERMINAL.contains(&turn_state(&turn)), "{turn}");
    assert_ne!(turn_state(&turn), "runtime_fault", "{turn}");
    let rows = tool_rows(&s.gw.messages("general").await?, &turn_id);
    let run = rows
        .iter()
        .find(|row| row["safe_tool_name"] == "run_command")
        .expect("run_command row");
    let output =
        s.gw.operation_output(&turn_id, run)
            .await
            .unwrap_or_default()
            .to_lowercase();
    assert!(
        output.contains("timeout") || output.contains("timed out") || run["state"] != "delivered",
        "timeout not reported: {run} {output}"
    );
    let pids = fs::read_to_string(s.sandbox.data.join("pids.txt"))?;
    let deadline = Instant::now() + Duration::from_secs(10);
    for pid in pids
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
    {
        loop {
            use butler_platform::process_control::{Liveness, liveness};
            let alive = liveness(pid) == Liveness::Running;
            if !alive {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "process {pid} from the timed-out command is still alive"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    s.finish().await
}

async fn authority_requests(s: &Scenario) -> Result<Value, HarnessError> {
    Ok(s.gw
        .get("/authority-requests?session_id=general")
        .await?
        .data()
        .clone())
}

async fn wait_request(s: &Scenario, turn_id: &str) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(butler_e2e::e2e::scenario::turn_timeout());
    loop {
        let page = authority_requests(s).await?;
        if let Some(request) = page["requests"]
            .as_array()
            .and_then(|list| {
                list.iter()
                    .find(|request| request["source_turn_id"] == turn_id)
            })
            .cloned()
        {
            return Ok(request);
        }
        assert!(
            Instant::now() < deadline,
            "no authority request appeared for turn {turn_id}: {page}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn request_ref(request: &Value) -> String {
    request["request_ref"]
        .as_str()
        .or_else(|| request["ref"].as_str())
        .unwrap_or_default()
        .to_owned()
}

/// Waits for `path`, supervising the agent; returns (found, restarts).
async fn wait_file(
    s: &mut Scenario,
    path: &Path,
    within: Duration,
) -> Result<(bool, u32), HarnessError> {
    let deadline = Instant::now() + within;
    let mut restarts = 0;
    while Instant::now() < deadline {
        if s.supervise().await? {
            restarts += 1;
        }
        if path.exists() {
            return Ok((true, restarts));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Ok((false, restarts))
}

/// Waits for the ask-first request of `turn_id` and checks that nothing ran
/// before a decision: the effect's file is absent and the turn is not
/// delivered. Returns the request reference.
async fn pending_request(
    s: &Scenario,
    turn_id: &str,
    target: &Path,
) -> Result<String, HarnessError> {
    let request = wait_request(s, turn_id).await?;
    let reference = request_ref(&request);
    assert!(!reference.is_empty(), "{request}");
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(!target.exists(), "effect ran before approval");
    let turn = s.gw.turn("general", turn_id).await?.unwrap_or_default();
    assert_ne!(
        turn_state(&turn),
        "delivered",
        "turn finished without approval: {turn}"
    );
    Ok(reference)
}

/// Waits until every turn of the general chat is terminal.
async fn all_turns_terminal(s: &Scenario, context: &str) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(butler_e2e::e2e::scenario::turn_timeout());
    loop {
        let turns = s.gw.turns("general").await?;
        if turns
            .iter()
            .all(|turn| TERMINAL.contains(&turn_state(turn)))
        {
            return Ok(());
        }
        assert!(Instant::now() < deadline, "{context}: {turns:?}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// The resumed turn is answered ("delivered"), not rejected or failed.
async fn assert_delivered(s: &Scenario, turn_id: &str) -> Result<(), HarnessError> {
    let turn = s.gw.turn("general", turn_id).await?.unwrap_or_default();
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    Ok(())
}

/// How many `write_file` rows of `turn_id` are in `state`.
async fn write_rows(s: &Scenario, turn_id: &str, state: &str) -> Result<usize, HarnessError> {
    Ok(tool_rows(&s.gw.messages("general").await?, turn_id)
        .iter()
        .filter(|row| row["safe_tool_name"] == "write_file" && row["state"] == state)
        .count())
}

/// Allows `reference` for the conversation: the effect runs once with the
/// requested content, the service does not exit, and the turn settles.
async fn allow_and_settle(
    s: &mut Scenario,
    reference: &str,
    target: &Path,
) -> Result<(), HarnessError> {
    let allow =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({"scope": "conversation"}),
        )
        .await?;
    assert_eq!(allow.status, 202, "{}", allow.text);
    let (found, restarts) = wait_file(
        s,
        target,
        Duration::from_secs(butler_e2e::e2e::scenario::turn_timeout()),
    )
    .await?;
    eprintln!(
        "TOOL-07 allow: found {found} restarts {restarts}; {}",
        interrupts(s)
    );
    assert!(found, "effect did not run after Allow");
    assert_eq!(
        restarts, 0,
        "the service exited while resuming the approved turn"
    );
    assert_eq!(fs::read_to_string(target)?.trim_end(), "approved-by-user");
    allow_result_read(s, target).await?;
    all_turns_terminal(s, "turn did not finish after Allow").await
}

/// The read-back is a separate exact operation approval in ask-first mode.
async fn allow_result_read(s: &Scenario, target: &Path) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(butler_e2e::e2e::scenario::turn_timeout());
    loop {
        let cards = s.gw.approval_requests("general").await?;
        if let Some(card) = cards.first() {
            assert_eq!(cards.len(), 1, "One exact read-back approval expected");
            assert_eq!(
                card["executable"], "read_file",
                "Unexpected follow-up operation"
            );
            assert_eq!(card["approval"]["examples"], json!([target]));
            let allowed =
                s.gw.post(
                    &format!(
                        "/authority-requests/{}/allow?session_id=general",
                        card["request_ref"].as_str().unwrap()
                    ),
                    json!({"scope":"once"}),
                )
                .await?;
            assert_eq!(allowed.status, 202);
            return Ok(());
        }
        if s.gw
            .turns("general")
            .await?
            .iter()
            .all(|t| TERMINAL.contains(&turn_state(t)))
        {
            return Ok(());
        }
        assert!(
            Instant::now() < deadline,
            "Exact read-back approval did not appear"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Revokes the conversation grant that Allow created; it is no longer listed.
async fn revoke_conversation_grant(s: &Scenario) -> Result<(), HarnessError> {
    let permissions = authority_requests(s).await?["permissions"].clone();
    let grants = permissions.as_array().cloned().unwrap_or_default();
    assert_eq!(
        grants.len(),
        1,
        "unexpected conversation grants: {permissions}"
    );
    assert_eq!(grants[0]["capability"], "write_file");
    assert_eq!(grants[0]["target"], "approved.txt");
    let grant = grants[0]["grant_ref"]
        .as_str()
        .or_else(|| grants[0]["ref"].as_str())
        .unwrap_or_default()
        .to_owned();
    assert!(
        !grant.is_empty(),
        "conversation grant not listed: {permissions}"
    );
    let revoked =
        s.gw.delete(&format!(
            "/authority-permissions/{grant}?session_id=general"
        ))
        .await?;
    assert_eq!(revoked.status, 200, "{}", revoked.text);
    assert!(
        !authority_requests(s).await?["permissions"]
            .to_string()
            .contains(&grant)
    );
    Ok(())
}

const TOOL_07_PROMPT: &str =
    "Create approved.txt in your workspace containing exactly: approved-by-user";

/// TOOL-07 (pending part) — ask-first: the effect waits for approval and the
/// request is listed; nothing runs before a decision.
#[tokio::test]
async fn tool_07_ask_first_waits_for_approval() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    // Replays the start of the TOOL-07 recording; only the full TOOL-07
    // scenario records that cassette.
    let s = Setup::new("TOOL-07-PENDING")?
        .cassette("TOOL-07")
        .replay_only()
        .start()
        .await?;
    let target = s.sandbox.data.join("approved.txt");
    let turn_id = send(&s, TOOL_07_PROMPT, "ask_first").await?;
    pending_request(&s, &turn_id, &target).await?;
    assert!(s.gw.healthy().await);
    s.finish().await
}

/// TOOL-07 — ask-first: the effect waits for approval, the request survives
/// a restart, the effect runs once after Allow, and the conversation grant
/// Allow created can be revoked.
#[tokio::test]
async fn tool_07_authority_allow_restart_and_revoke() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("TOOL-07")?.cassette("TOOL-07").start().await?;
    let target = s.sandbox.data.join("approved.txt");
    let turn_id = send(&s, TOOL_07_PROMPT, "ask_first").await?;
    let reference = pending_request(&s, &turn_id, &target).await?;

    s.restart().await?;
    let pending = authority_requests(&s).await?;
    assert!(
        pending.to_string().contains(&reference),
        "pending request lost on restart: {pending}"
    );

    allow_and_settle(&mut s, &reference, &target).await?;
    assert_eq!(
        write_rows(&s, &turn_id, "delivered").await?,
        1,
        "the approved effect must run exactly once"
    );
    assert_delivered(&s, &turn_id).await?;
    revoke_conversation_grant(&s).await?;
    s.finish().await
}

/// TOOL-07 (deny) — a denied effect never runs and the turn ends visibly.
#[tokio::test]
async fn tool_07_authority_deny() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("TOOL-07-DENY")?
        .cassette("TOOL-07-DENY")
        .start()
        .await?;
    let target = s.sandbox.data.join("denied.txt");
    let turn_id = send(
        &s,
        "Create denied.txt in your workspace containing exactly: should-not-exist",
        "ask_first",
    )
    .await?;
    let request = wait_request(&s, &turn_id).await?;
    let reference = request_ref(&request);
    let deny =
        s.gw.post(
            &format!("/authority-requests/{reference}/deny?session_id=general"),
            json!({}),
        )
        .await?;
    assert_eq!(deny.status, 202, "{}", deny.text);
    let (_, restarts) = wait_file(&mut s, &target, Duration::from_secs(15)).await?;
    eprintln!("TOOL-07 deny: restarts {restarts}; {}", interrupts(&s));
    assert_eq!(restarts, 0, "the service exited after Deny");
    all_turns_terminal(&s, "turn stuck after Deny").await?;
    assert_delivered(&s, &turn_id).await?;
    assert_eq!(
        write_rows(&s, &turn_id, "delivered").await?,
        0,
        "the denied effect ran"
    );
    assert!(!target.exists(), "denied effect ran");
    s.finish().await
}

fn interrupts(s: &Scenario) -> String {
    s.agent
        .logs()
        .lines()
        .filter(|line| line.contains("interrupted code"))
        .collect::<Vec<_>>()
        .join(" | ")
}

/// #314: a long command reaches the public App approval API verbatim.
#[tokio::test]
async fn approval_long_command_is_complete() -> Result<(), HarnessError> {
    use butler_e2e::e2e::faults::{ArgsMutation, Fault, Transform};
    butler_e2e::gate!();
    let s = Setup::new("APPROVAL-LONG")?
        .cassette("TOOL-06")
        .replay_only()
        .start()
        .await?;
    let original = "sh -c 'sleep 300 & echo $! > pids.txt; echo $$ >> pids.txt; sleep 300'";
    let command = format!("printf '%s' '{}'", "approval-detail-".repeat(40));
    assert!(command.len() > 200);
    s.provider
        .as_ref()
        .expect("replay provider")
        .inject(Fault::first_call(
            "Use run_command with timeout_ms 3000",
            Transform::MutateToolArgs(ArgsMutation::OnlyTool {
                tool: "run_command".into(),
                mutation: Box::new(ArgsMutation::Replace {
                    from: original.into(),
                    to: command.clone(),
                }),
            }),
        ))?;
    let prompt = "Use run_command with timeout_ms 3000 to run exactly: sh -c 'sleep 300 & echo $! > pids.txt; echo $$ >> pids.txt; sleep 300'. Then tell me what happened.";
    let turn_id = send(&s, prompt, "ask_first").await?;
    let request = wait_request(&s, &turn_id).await?;
    assert_eq!(request["approval"]["examples"], json!([command]));
    assert!(request["approval"].get("examples_truncated").is_none());
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.status, 200, "{}", view.text);
    assert_eq!(view.data()["authority_requests"], json!([request]));
    assert_eq!(view.data()["pending_questions"], json!([]));
    assert!(s.gw.healthy().await);
    s.finish().await
}
