use super::*;

#[tokio::test]
async fn three_tool_only_questions_keep_durable_assistant_answer_segments()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("ASK-USER-CONSECUTIVE")?
        .stub_cassette(stub::consecutive_cassette()?)
        .start()
        .await?;
    let turn = accepted_turn_id(&s.gw.say("general", stub::PROMPT).await?)?;
    let mut refs = Vec::new();
    for question_index in 0..3 {
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        let q = loop {
            let view = s.gw.get("/session-view?session_id=general").await?;
            let q = &view.data()["pending_questions"][0];
            if q["request_ref"]
                .as_str()
                .is_some_and(|id| !refs.contains(&id.to_owned()))
            {
                break q.clone();
            }
            assert!(
                std::time::Instant::now() < deadline,
                "next question missing: {view:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        refs.push(q["request_ref"].as_str().unwrap().to_owned());
        s.restart().await?;
        let view = s.gw.get("/session-view?session_id=general").await?;
        assert_eq!(view.data()["pending_questions"][0], q);
        let messages = view.data()["messages"].as_array().unwrap();
        let assistant: Vec<_> = messages
            .iter()
            .filter(|m| m["role"] == "assistant")
            .collect();
        assert_eq!(assistant.len(), question_index + 1, "{messages:?}");
        assert!(assistant.iter().all(|m| m["status"] == "delivered"));
        assert_eq!(
            view.data()["question_answers"].as_array().unwrap().len(),
            question_index
        );
        reply(&s, &q, answer()).await?;
    }
    let done =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}");
    s.restart().await?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    let assistant: Vec<_> = view.data()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "assistant")
        .collect();
    assert_eq!(assistant.len(), 4, "{view:?}");
    assert_eq!(assistant[3]["text"], "I received your answer.");
    assert!(
        assistant
            .windows(2)
            .all(|pair| pair[0]["cursor"].as_u64() < pair[1]["cursor"].as_u64())
    );
    let answers = view.data()["question_answers"].as_array().unwrap();
    assert_eq!(answers.len(), 3);
    for request in refs {
        assert!(
            answers
                .iter()
                .any(|a| a["request_ref"] == request && a["response"] == answer())
        );
    }
    assert_eq!(
        s.provider()?.requests().len(),
        4,
        "four stub rounds across restarts"
    );
    s.finish().await
}
