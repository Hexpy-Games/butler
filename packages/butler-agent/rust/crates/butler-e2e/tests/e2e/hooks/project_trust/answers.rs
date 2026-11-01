//! The saved answers, as Settings shows them. Clearing one brings its question back, and
//! clearing can never trust a folder.
use super::*;

async fn answers(s: &Scenario) -> Result<Value, HarnessError> {
    let listed = api(s, Method::GET, "/hooks/project-answers", None).await?;
    assert_eq!(listed.status, 200, "{}", listed.text);
    Ok(listed.data().clone())
}

async fn clear(s: &Scenario, path: &str) -> Result<Value, HarnessError> {
    let cleared = api(
        s,
        Method::POST,
        "/hooks/project-answers/clear",
        Some(json!({"path":path})),
    )
    .await?;
    assert_eq!(cleared.status, 200, "{}", cleared.text);
    Ok(cleared.data().clone())
}

#[tokio::test]
async fn project_hook_answer_cleared_in_settings_asks_again() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-CLEAR").await?;
    let chat = project.chat.clone();
    assert_eq!(answers(&s).await?, json!([]));
    project.write(&[project.observer("guard", "Stop", "ran.jsonl")])?;

    // A mistaken refusal, saved and silent from then on.
    let turn = s.gw.say_turn(&chat, "First.").await?;
    answer(&s, &chat, &card(&s, &chat).await?, "deny").await?;
    delivered(&s, &chat, &turn).await?;
    quiet_turn(&s, &chat, "Second.").await?;
    let saved = answers(&s).await?;
    assert_eq!(saved.as_array().unwrap().len(), 1, "{saved}");
    assert_eq!(saved[0]["run"], false);
    let path = saved[0]["path"].as_str().unwrap().to_owned();
    assert!(path.ends_with("작업 Project"), "{path}");

    // Only the app on this computer, with its admin credential, reaches the answers.
    assert_eq!(s.gw.get("/hooks/project-answers").await?.status, 403);
    let refused =
        s.gw.post("/hooks/project-answers/clear", json!({"path":path}))
            .await?;
    assert_eq!(refused.status, 403, "{}", refused.text);
    assert_eq!(answers(&s).await?, saved);

    // Clearing a folder with no answer changes nothing.
    assert_eq!(clear(&s, "/no/such/folder").await?, saved);
    assert_eq!(clear(&s, &path).await?, json!([]));

    // The question is back, and this time the hooks run.
    let turn = s.gw.say_turn(&chat, "Third.").await?;
    let asked = card(&s, &chat).await?;
    assert_eq!(project.ran("ran.jsonl").len(), 0);
    answer(&s, &chat, &asked, "allow").await?;
    delivered(&s, &chat, &turn).await?;
    assert_eq!(project.ran("ran.jsonl").len(), 1);
    assert_eq!(answers(&s).await?[0]["run"], true);
    s.finish().await
}
