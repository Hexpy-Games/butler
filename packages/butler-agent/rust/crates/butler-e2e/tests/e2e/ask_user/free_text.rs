use super::*;

/// A free-text question is one input; options that duplicate the card's Skip and
/// free input are dropped by their kind; a text question with options is fed back.
#[tokio::test]
async fn ask_user_free_text_and_card_control_options() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let invalid = json!({"questions":[{"id":"name","eyebrow":"Name","title":"What is your name?","kind":"text","allow_custom":true,
        "options":[{"id":"tell","label":"I'll tell you","kind":"input"},{"id":"skip","label":"Skip for now","kind":"skip"}]}]});
    let raw = json!({"questions":[
        {"id":"name","eyebrow":"Name","title":"What is your name?","kind":"text","allow_custom":false,"options":[]},
        {"id":"address","eyebrow":"Address","title":"How should I address you?","kind":"single","allow_custom":false,"options":[
            {"id":"boss","label":"Boss","kind":"answer"},
            {"id":"own","label":"I'll choose","description":"Type it in the input","kind":"input"},
            {"id":"later","label":"Skip","kind":"skip"}]}]});
    let s = Setup::new("ASK-USER-FREE-TEXT")?
        .stub_cassette(stub::free_text_cassette(&invalid, &raw)?)
        .start()
        .await?;
    let turn = s.gw.say_turn("general", stub::PROMPT).await?;
    let parked =
        s.gw.wait_turn(
            "general",
            &turn,
            &["waiting_for_form", "failed", "delivered"],
            Duration::from_secs(20),
        )
        .await?;
    assert_eq!(turn_state(&parked), "waiting_for_form", "{parked}");
    // Round 1 was rejected with the reason, so the model could retry.
    let feedback = s.provider()?.requests()[1]["input"].to_string();
    assert!(
        feedback.contains("invalid_arguments")
            && feedback.contains("A text question takes no options"),
        "{feedback}"
    );
    let view = s.gw.get("/session-view?session_id=general").await?;
    let q = view.data()["pending_questions"][0].clone();
    assert_eq!(
        q["questions"],
        json!({"questions":[
            {"id":"name","eyebrow":"Name","title":"What is your name?","kind":"text","allow_custom":true,"options":[]},
            {"id":"address","eyebrow":"Address","title":"How should I address you?","kind":"single","allow_custom":true,
                "options":[{"id":"boss","label":"Boss"}]}]}),
        "skip and input options never reach the card"
    );
    // A dropped option is no longer an answer.
    let stale = json!({"status":"answered","answers":[
        {"id":"name","selected":[],"custom":"Grace","skipped":false},
        {"id":"address","selected":["later"],"custom":null,"skipped":false}]});
    let rejected =
        s.gw.post(
            &format!(
                "/authority-requests/{}/answer?session_id=general",
                q["request_ref"].as_str().unwrap()
            ),
            stale,
        )
        .await?;
    assert_eq!(rejected.status, 400, "{}", rejected.text);
    let answer = json!({"status":"answered","answers":[
        {"id":"name","selected":[],"custom":"Grace","skipped":false},
        {"id":"address","selected":[],"custom":"Captain","skipped":false}]});
    reply(&s, &q, answer.clone()).await?;
    let done =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}");
    let requests = s.provider()?.requests();
    assert_eq!(requests.len(), 3, "one feedback round, one answer round");
    let input = requests[2]["input"].to_string();
    assert!(
        input.contains("Grace") && input.contains("Captain"),
        "{input}"
    );
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.data()["question_answers"][0]["response"], answer);
    s.finish().await
}
