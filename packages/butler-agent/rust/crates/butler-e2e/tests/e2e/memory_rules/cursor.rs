//! Continuations opened before mutation revalidate sources in the same turn.
use super::{forget, support};
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Fixture, Setup, accepted_turn_id},
};
use serde_json::json;
use std::time::Duration;

const FIRST: &str = "Recall one bike lock rule from all chats, then continue the exact recall.";

fn stub() -> Result<butler_e2e::e2e::cassette::Cassette, HarnessError> {
    let mut cassette = forget::stub()?;
    support::add_call(
        &mut cassette,
        FIRST,
        "recall_memory",
        &json!({"cue":"bike lock code","scope":"all_user_sessions","include_vector":false,"limit":1}),
    );
    let follow = cassette.exchanges.last_mut().unwrap();
    follow.response = support::response(
        &json!({"type":"function_call","id":"fc_cursorcontinuation0000","call_id":"call_cursorcontinuation0000","name":"recall_memory","status":"completed","arguments":json!({"cue":"bike lock code","scope":"all_user_sessions","include_vector":false,"limit":1,"cursor":"{{CURSOR}}"}).to_string()}),
    );
    let mut final_answer = follow.clone();
    final_answer
        .request
        .key
        .round
        .extend(["function_call".into(), "function_call_output".into()]);
    final_answer.response = support::response(
        &json!({"type":"message","id":"msg_cursoranswer0000","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Done.","annotations":[]}]}),
    );
    cassette.exchanges.push(final_answer);
    support::historical(&mut cassette);
    Ok(cassette)
}

#[tokio::test]
async fn rules_old_cursors_exclude_corrected_and_forgotten_sources() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("RULES-CURSORS")?
        .fixture(Fixture::Empty)
        .stub_cassette(stub()?);
    let mut s = forget::start(setup).await?;
    for user in [forget::GLOBAL, forget::A] {
        let output = support::tool(&s, "general", user, "update_explicit_memory").await?;
        assert_eq!(output["ok"], true, "{output}");
    }
    for row in support::active_rules(&s.sandbox.data) {
        support::projection(&s.sandbox.data, &row).await;
    }
    super::fts_pending::coalesce(&s.sandbox.data)?;
    super::fts_pending::upgrade(&mut s).await?;
    let other = support::new_chat(&s, "Mutation while continuing recall").await?;
    for (user, name) in [
        (forget::CORRECT, "update_explicit_memory"),
        (forget::FORGET, "forget_explicit_memory"),
    ] {
        let gate = s.provider()?.hold_after_tool(FIRST);
        let first_request = s.provider()?.requests().len();
        let turn_id = accepted_turn_id(&s.gw.say("general", FIRST).await?)?;
        support::until(|| s.provider().unwrap().requests().len() >= first_request + 2).await;
        let first = committed_recall(&s.sandbox.data, &turn_id);
        assert_eq!(first["ok"], true, "{first}");
        assert_eq!(first["results"].as_array().unwrap().len(), 1, "{first}");
        s.provider()?
            .add_placeholder("CURSOR", first["next_cursor"].as_str().unwrap());
        let shown = support::typed_evidence(&first);
        assert_eq!(shown.len(), 1, "{first}");
        let candidates = support::active_rules(&s.sandbox.data);
        let retired = candidates
            .iter()
            .find(|row| {
                let text = std::fs::read_to_string(
                    s.sandbox
                        .data
                        .join("cognition/memory/rules")
                        .join(format!("{}.md", row["record_id"].as_str().unwrap())),
                )
                .unwrap();
                shown[0]["excerpt"] != text
            })
            .expect("cursor must contain the other active rule")
            .clone();
        let text = std::fs::read_to_string(
            s.sandbox
                .data
                .join("cognition/memory/rules")
                .join(format!("{}.md", retired["record_id"].as_str().unwrap())),
        )?;
        s.provider()?
            .add_placeholder("TARGET", retired["handle"].as_str().unwrap());
        let output = support::tool(&s, &other, user, name).await?;
        assert_eq!(output["ok"], true, "{output}");
        gate.release();
        let turn =
            s.gw.wait_terminal("general", &turn_id, Duration::from_secs(90))
                .await?;
        assert_eq!(turn["state"], "delivered", "{turn}");
        let next = support::result(&s, "general", &turn_id, "recall_memory").await?;
        assert!(
            !next.to_string().contains(&text),
            "same-turn cursor exposed retired text: {next}"
        );
        assert!(
            support::typed_evidence(&next)
                .iter()
                .all(|row| row["excerpt"] != text),
            "{next}"
        );
        if next["ok"] != true {
            assert!(
                next["error"]["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("stale_cursor")),
                "unexpected continuation error: {next}"
            );
        }
        if name == "update_explicit_memory" {
            let latest = support::active_rules(&s.sandbox.data)
                .into_iter()
                .find(|row| row["handle"] == retired["handle"])
                .unwrap();
            support::projection(&s.sandbox.data, &latest).await;
            assert_eq!(support::active_rules(&s.sandbox.data).len(), 2);
        } else {
            assert_eq!(support::active_rules(&s.sandbox.data).len(), 1);
            let recalled = support::tool(&s, &other, forget::RECALL, "recall_memory").await?;
            assert_eq!(support::typed_evidence(&recalled).len(), 1, "{recalled}");
            assert_eq!(
                support::typed_evidence(&recalled)[0]["excerpt"],
                shown[0]["excerpt"],
                "unrelated rule changed"
            );
        }
        eprintln!(
            "RULES-CURSOR tool={name} same_turn=true retired_pending_candidate_excluded=true"
        );
    }
    s.finish().await?;
    Ok(())
}

/// A held turn has no delivered message/activity projection yet. Inspect its
/// complete tool-owner receipt, without releasing the reply barrier.
fn committed_recall(data: &std::path::Path, turn: &str) -> serde_json::Value {
    let db = rusqlite::Connection::open_with_flags(
        data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let output: String = db.query_row(
        "SELECT result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='recall_memory' AND status='completed' ORDER BY turn_sequence DESC LIMIT 1", [turn], |row| row.get(0),
    ).unwrap();
    serde_json::from_str(&output).unwrap()
}
