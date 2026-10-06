use super::*;
#[tokio::test]
async fn hooks_shutdown_kills_pretool_tree_and_recovers_two_followups() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let setup = Setup::new("HOOK-SHUTDOWN")?.synthetic(Script {
        rounds: 1,
        path_for: Box::new(|_| "input.txt".into()),
        final_text: "Recovered.".into(),
    });
    fs::write(setup.sandbox.data.join("input.txt"), "input")?;
    let pids = setup.sandbox.home.join("hook-pids");
    configure(
        &setup,
        &[
            json!({"id":"tree","event":"PreToolUse","type":"command","args":fixture(&setup,"tree"),
        "timeout_ms":30000,"env":{"HOOK_PIDS":pids}}),
        ],
    )?;
    let mut s = setup.start().await?;
    let accepted = s.gw.say("general", "Start the held read.").await?;
    let active = butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !pids.exists() {
        assert!(Instant::now() < deadline, "hook never spawned");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    for text in ["First follow-up.", "Second follow-up."] {
        let queued = s.gw.post("/session-queue", json!({"chat_id":"general","text":text,"client_message_id":uuid::Uuid::new_v4().to_string()})).await?;
        assert_eq!(queued.status, 202, "{queued:?}");
    }
    let descendants: Vec<u32> = fs::read_to_string(&pids)?
        .lines()
        .map(|p| p.trim().parse().unwrap())
        .collect();
    assert_eq!(descendants.len(), 2);
    replace(&s, vec![]).await?;
    s.restart().await?;
    for pid in descendants {
        assert_eq!(process_control::liveness(pid), Liveness::Gone);
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let turns = s.gw.turns("general").await?;
        if turns.iter().filter(|t| t["state"] == "delivered").count() == 2 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "follow-ups did not recover: {turns:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let interrupted = s.gw.turn("general", &active).await?.unwrap();
    assert_eq!(interrupted["state"], "failed");
    assert_eq!(interrupted["retryable"], true);
    assert_eq!(
        s.gw.messages("general")
            .await?
            .iter()
            .filter(|m| m["role"] == "user")
            .count(),
        3
    );
    s.finish().await
}
