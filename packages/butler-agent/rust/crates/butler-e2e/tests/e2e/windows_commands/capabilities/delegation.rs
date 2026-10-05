use super::*;

pub(super) async fn approve(
    s: &Scenario,
    chat: &str,
    script: &provider::Script,
) -> Result<(), HarnessError> {
    use std::sync::atomic::Ordering;
    script.select(Case {
        tool: "write_file",
        args: json!({"path":"home/Downloads/위임 파일.txt","content":"승인된 내용"}),
        refused: false,
    });
    script.delegated.store(true, Ordering::SeqCst);
    s.turn(chat, provider::DELEGATE_PROMPT).await?;
    let deadline = Instant::now() + Duration::from_secs(15);
    let card = loop {
        let cards = s.gw.approval_requests(chat).await?;
        if let Some(card) = cards
            .iter()
            .find(|c| c["approval"]["action_kind"] == "edit_files")
        {
            break card.clone();
        }
        assert!(
            Instant::now() < deadline,
            "Child approval missing from parent session: cards={cards:?}, view={:?}",
            s.gw.get(&format!("/session-view?session_id={chat}"))
                .await?
                .data()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    assert!(!s.sandbox.home.join("Downloads/위임 파일.txt").exists());
    let view =
        s.gw.get(&format!("/session-view?session_id={chat}"))
            .await?;
    assert!(
        view.data()["authority_requests"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["request_ref"] == card["request_ref"]),
        "Parent UI receives the pending card"
    );
    let reply =
        s.gw.post(
            &format!(
                "/authority-requests/{}/allow?session_id={chat}",
                card["request_ref"].as_str().unwrap()
            ),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    loop {
        let view =
            s.gw.get(&format!("/session-view?session_id={chat}"))
                .await?;
        if view.data()["steward_children"][0]["result"]["status"] == "success" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Child did not resume after parent Allow: {view:?}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(
        std::fs::read_to_string(s.sandbox.home.join("Downloads/위임 파일.txt"))?,
        "승인된 내용"
    );
    let (_, elapsed) = script.result.lock().unwrap().clone().unwrap();
    butler_e2e::assert_wall_clock_budget!(
        elapsed,
        Duration::from_secs(5),
        "Delegated write approval/resume"
    );
    Ok(())
}
