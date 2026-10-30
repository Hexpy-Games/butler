//! Hooks the user allowed cannot be switched off quietly: deleting the file, turning
//! them off or breaking it asks at the next turn, and a schedule reports it.
use super::*;

fn off(card: &Value) -> &Value {
    assert_eq!(card["approval"]["action_kind"], "project_hooks", "{card}");
    &card["approval"]["project_hooks"]["off"]
}

/// Allows `hooks` from a first-run card, so the folder has something to lose.
async fn allowed(s: &Scenario, project: &Project, hooks: &[Value]) -> Result<(), HarnessError> {
    let chat = &project.chat;
    project.write(hooks)?;
    let turn = s.gw.say_turn(chat, "Allow these.").await?;
    let asked = card(s, chat).await?;
    answer(s, chat, &asked, "allow").await?;
    delivered(s, chat, &turn).await
}

#[tokio::test]
async fn project_hooks_going_away_asks_before_the_turn_goes_on() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-OFF").await?;
    let chat = project.chat.clone();
    let guard = project.observer("guard", "PreToolUse", "guard.jsonl");
    let hook_file = project.root.join(".butler/hooks.json");
    let mut disabled = guard.clone();
    disabled["enabled"] = json!(false);
    let web = json!({"id":"web","event":"Stop","type":"http","url":"http://127.0.0.1:9/h"});
    let ways: [(&str, &dyn Fn() -> Result<(), HarnessError>); 4] = [
        ("missing", &|| Ok(fs::remove_file(&hook_file)?)),
        ("disabled", &|| project.write(&[disabled.clone()])),
        ("refused", &|| project.write(&[web.clone()])),
        ("refused", &|| Ok(fs::write(&hook_file, "{broken")?)),
    ];
    for (kind, switch_off) in ways {
        allowed(&s, &project, &[guard.clone()]).await?;
        let runs = project.ran("guard.jsonl").len();
        switch_off()?;
        let turn = s.gw.say_turn(&chat, "After it went away.").await?;
        let asked = card(&s, &chat).await?;
        assert_eq!(off(&asked), kind, "{asked}");
        assert_eq!(asked["approval"]["risk"], "high");
        let shown = lines(&asked);
        assert_eq!(shown.len(), 1, "{shown:?}");
        assert_eq!(shown[0]["change"], "removed");
        // Waiting, and the model has not been told to go on without its guard.
        assert_eq!(project.ran("guard.jsonl").len(), runs);
        answer(&s, &chat, &asked, "allow").await?;
        delivered(&s, &chat, &turn).await?;
        assert_eq!(project.ran("guard.jsonl").len(), runs);
        // The user accepted it: the same state asks nobody.
        quiet_turn(&s, &chat, "Still off.").await?;
    }
    s.finish().await
}

#[tokio::test]
async fn project_hooks_stopping_at_the_off_card_asks_again() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-OFF-STOP").await?;
    let chat = project.chat.clone();
    let guard = project.observer("guard", "PreToolUse", "guard.jsonl");
    allowed(&s, &project, &[guard.clone()]).await?;
    fs::remove_file(project.root.join(".butler/hooks.json"))?;
    let turn = s.gw.say_turn(&chat, "Go on.").await?;
    assert_eq!(off(&card(&s, &chat).await?), "missing");
    let stopped =
        s.gw.post(&format!("/turns/{turn}/cancel"), json!({}))
            .await?;
    assert!(stopped.status < 300, "{}", stopped.text);
    let done =
        s.gw.wait_terminal(&chat, &turn, Duration::from_secs(30))
            .await?;
    assert_eq!(done["state"], "cancelled", "{done}");
    // Restored exactly, the allowed content needs no new answer.
    project.write(&[guard])?;
    let runs = project.ran("guard.jsonl").len();
    quiet_turn(&s, &chat, "Restored.").await?;
    assert_eq!(project.ran("guard.jsonl").len(), runs + 1);
    s.finish().await
}

async fn reports(s: &Scenario) -> Result<i64, HarnessError> {
    let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    Ok(db.query_row(
        "SELECT count(*) FROM app_initiated_messages WHERE kind='approval_needed'",
        [],
        |row| row.get(0),
    )?)
}

#[tokio::test]
async fn project_hooks_a_schedule_reports_what_it_could_not_ask() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-OFF-SCHEDULE").await?;
    let chat = project.chat.clone();
    // Never allowed: nothing is lost, so the run says nothing.
    project.write(&[project.observer("guard", "Stop", "first.jsonl")])?;
    boundary::scheduled_run(&s, &chat, "Never answered").await?;
    assert_eq!(reports(&s).await?, 0);
    assert_eq!(project.ran("first.jsonl").len(), 0);

    allowed(
        &s,
        &project,
        &[project.observer("guard", "Stop", "first.jsonl")],
    )
    .await?;
    fs::remove_file(project.root.join(".butler/hooks.json"))?;
    boundary::scheduled_run(&s, &chat, "Gone").await?;
    assert_eq!(s.gw.approval_requests(&chat).await?, Vec::<Value>::new());
    assert_eq!(reports(&s).await?, 1, "{}", s.agent.logs());
    let ran = project.ran("first.jsonl").len();

    project.write(&[project.observer("guard", "Stop", "changed.jsonl")])?;
    boundary::scheduled_run(&s, &chat, "Changed").await?;
    assert_eq!(reports(&s).await?, 2, "{}", s.agent.logs());
    assert_eq!(project.ran("changed.jsonl").len(), 0);
    assert_eq!(project.ran("first.jsonl").len(), ran);
    s.finish().await
}
