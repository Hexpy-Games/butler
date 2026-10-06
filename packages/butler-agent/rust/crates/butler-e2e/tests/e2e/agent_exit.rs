//! Linux reproduction of preview policy interruption and truthful session recovery.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
#[path = "agent_exit/stub.rs"]
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Setup, accepted_turn_id},
};
use serde_json::json;
use std::time::{Duration, Instant};

#[tokio::test]
async fn policy_refusals_feed_back_to_model_without_interrupting_service()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let worker = json!({"action_key":"action","objective":"test","acceptance_criteria":["done"],"implementation_brief":"test"});
    for (tool, args, code) in [
        (
            "delegate_to_steward",
            json!({"request":"test"}),
            "delegation_reviewed_plan_required",
        ),
        // Butler may delegate only to a Steward; Worker calls are model feedback too.
        ("delegate_to_worker", worker, "tool_unavailable"),
        (
            "delegate_to_steward",
            json!({"request":" "}),
            "steward_delegation_input_invalid",
        ),
        (
            "steer_steward",
            json!({"instruction":"test","relation_id":"missing"}),
            "steward_relation_not_found",
        ),
        (
            "update_todo_list",
            json!({"todos":[{"content":"one","active_form":"doing one","status":"in_progress"},{"content":"two","active_form":"doing two","status":"in_progress"}]}),
            "todo_multiple_active",
        ),
    ] {
        let s = Setup::new(tool)?
            .stub_cassette(stub::cassette(tool, &args)?)
            .start()
            .await?;
        let pid = s.agent.pid();
        let (_, turn) = s.turn("general", stub::PROMPT).await?;
        assert_eq!(
            turn_state(&turn),
            "delivered",
            "{tool}: {turn}\n{}",
            s.agent.logs()
        );
        let requests = s.provider()?.requests();
        assert_eq!(requests.len(), 2, "{tool}: {requests:?}");
        let feedback = requests[1]["input"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["type"] == "function_call_output")
            .unwrap()["output"]
            .as_str()
            .unwrap();
        assert!(feedback.contains(code), "{tool}: {feedback}");
        assert!(feedback.contains("occurred 1 times"), "{tool}: {feedback}");
        if code == "tool_unavailable" {
            assert!(feedback.contains("Choose an available tool"), "{feedback}");
        } else {
            assert!(feedback.contains("current_state"), "{tool}: {feedback}");
            assert!(feedback.contains("available_tools"), "{tool}: {feedback}");
            assert!(feedback.contains("schema"), "{tool}: {feedback}");
        }

        assert!(
            !s.agent
                .logs()
                .contains("native_service_replacement_required")
        );
        assert!(s.gw.healthy().await);
        assert_eq!(s.agent.pid(), pid);
        s.finish().await?;
    }
    Ok(())
}

#[tokio::test]
async fn runtime_interrupt_keeps_process_and_drains_followups_truthfully()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("INTERRUPT-IN-PROCESS")?
        .env("BUTLER_E2E_INTERRUPT_TOOL", "delegate_to_steward")
        .stub_cassette(stub::cassette(
            "delegate_to_steward",
            &json!({"request":"test"}),
        )?)
        .start()
        .await?;
    std::fs::write(s.sandbox.data.join("e2e-interrupt-tool"), b"once")?;
    std::fs::write(s.sandbox.data.join("e2e-interrupt-report"), b"once")?;
    let pid = s.agent.pid();
    let turn = accepted_turn_id(&s.gw.say("general", stub::PROMPT).await?)?;
    s.gw.post(
        "/session-queue",
        json!({"chat_id":"general","text":"Reply with exactly the word: waiting",
        "client_message_id":uuid::Uuid::new_v4().to_string()}),
    )
    .await?;
    let interrupted =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(15))
            .await?;
    assert_eq!(turn_state(&interrupted), "failed", "{interrupted}");
    assert_eq!(interrupted["retryable"], true);
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_ne!(view.data()["active_turn"]["id"], turn, "{}", view.text);
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let turns = s.gw.turns("general").await?;
        if turns.iter().any(|turn| turn_state(turn) == "delivered") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "followup stuck: {turns:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        s.provider()?.served(),
        2,
        "interrupted model turn was resumed"
    );
    assert_eq!(s.agent.pid(), pid);
    assert!(s.gw.healthy().await);
    s.finish().await
}
