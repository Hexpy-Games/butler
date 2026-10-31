//! The question asked when a project is added: what the app's dialog reads and answers.
//! Closing the dialog posts nothing, so the first message's card still asks.
use super::super::context::prompts;
use super::*;

fn store(s: &Scenario) -> std::path::PathBuf {
    s.sandbox.data.join("auth/project-hook-trust.json")
}

fn route(project: &Project) -> String {
    format!("/projects/{}/folder-trust", project.id)
}

async fn question(s: &Scenario, project: &Project) -> Result<Value, HarnessError> {
    let reply = s.gw.get(&route(project)).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data()["question"].clone())
}

async fn reply(
    s: &Scenario,
    project: &Project,
    trusted: bool,
    hooks: &Value,
) -> Result<(), HarnessError> {
    let sent =
        s.gw.post(&route(project), json!({"trusted":trusted,"hooks":hooks}))
            .await?;
    assert_eq!(sent.status, 200, "{}", sent.text);
    Ok(())
}

/// Trusted when added, so the first chat's SessionStart text is an ordinary part of its
/// first turn: nothing was held back, and nothing is dropped.
#[tokio::test]
async fn project_added_and_trusted_runs_with_no_card() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-ADD-TRUST").await?;
    let start_text = json!({"hookSpecificOutput":{"additionalContext":"ADD-START-MARK"}});
    project.write(&[
        project.printing("told", "SessionStart", &start_text.to_string()),
        project.observer("guard", "Stop", "ran.jsonl"),
    ])?;
    let asked = question(&s, &project).await?;
    let folder = asked["folder"].as_str().unwrap();
    assert!(
        Path::new(folder).is_absolute() && folder.ends_with("작업 Project"),
        "{folder}"
    );
    assert_eq!(asked["hooks"].as_array().unwrap().len(), 2);
    assert_eq!(asked["hooks"][1]["event"], "Stop");
    assert_eq!(asked.get("project_identity"), None, "{asked}");
    assert!(!store(&s).exists(), "reading the question saved something");
    reply(&s, &project, true, &asked["hooks"]).await?;
    assert_eq!(question(&s, &project).await?, Value::Null);

    let chat = project.new_chat(&s).await?;
    quiet_turn(&s, &chat, "First.").await?;
    assert_eq!(project.ran("ran.jsonl").len(), 1);
    let prompt = prompts(&s)?
        .into_iter()
        .rfind(|prompt| prompt.contains("First."))
        .unwrap();
    assert!(prompt.contains("ADD-START-MARK"), "{prompt}");
    assert!(
        prompt.contains("scope=project event=SessionStart>"),
        "{prompt}"
    );
    let runs = api(&s, Method::GET, "/hooks/runs", None).await?;
    assert!(
        !runs.text.contains("Added text was dropped"),
        "{}",
        runs.text
    );
    s.finish().await
}

#[tokio::test]
async fn project_added_and_refused_runs_nothing_and_asks_nothing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-ADD-REFUSE").await?;
    project.write(&[project.observer("guard", "Stop", "ran.jsonl")])?;
    let asked = question(&s, &project).await?;
    reply(&s, &project, false, &asked["hooks"]).await?;
    assert_eq!(question(&s, &project).await?, Value::Null);
    let chat = project.new_chat(&s).await?;
    quiet_turn(&s, &chat, "First.").await?;
    assert_eq!(project.ran("ran.jsonl").len(), 0);

    // An answered question cannot be answered again through this route.
    reply(&s, &project, true, &asked["hooks"]).await?;
    quiet_turn(&s, &chat, "Second.").await?;
    assert_eq!(project.ran("ran.jsonl").len(), 0);
    s.finish().await
}

/// Closing the dialog is what posting nothing means.
#[tokio::test]
async fn project_added_with_no_answer_asks_at_the_first_message() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-ADD-CLOSED").await?;
    project.write(&[project.observer("guard", "Stop", "ran.jsonl")])?;
    question(&s, &project).await?;
    let chat = project.new_chat(&s).await?;
    let turn = s.gw.say_turn(&chat, "First.").await?;
    let asked = card(&s, &chat).await?;
    assert_eq!(lines(&asked).len(), 1);
    assert_eq!(project.ran("ran.jsonl").len(), 0);
    answer(&s, &chat, &asked, "allow").await?;
    delivered(&s, &chat, &turn).await?;
    assert_eq!(project.ran("ran.jsonl").len(), 1);
    assert_eq!(question(&s, &project).await?, Value::Null);
    s.finish().await
}

/// Nothing to ask about: no hooks, none enabled, or a file that can't be used.
#[tokio::test]
async fn project_added_without_usable_hooks_asks_nothing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-ADD-NONE").await?;
    let hook = project.observer("guard", "Stop", "ran.jsonl");
    assert_eq!(question(&s, &project).await?, Value::Null);
    let mut idle = hook.clone();
    idle["enabled"] = json!(false);
    project.write(&[idle])?;
    assert_eq!(question(&s, &project).await?, Value::Null);
    let file = project.root.join(".butler/hooks.json");
    fs::write(&file, "{broken")?;
    assert_eq!(question(&s, &project).await?, Value::Null);
    reply(&s, &project, true, &json!([])).await?;
    reply(&s, &project, false, &json!([])).await?;
    assert!(!store(&s).exists(), "an unusable file saved an answer");
    if command_sandbox::POSIX_SHELL {
        let outside = s.sandbox.root.join("outside-hooks.json");
        fs::write(&outside, json!({"version":1,"hooks":[hook]}).to_string())?;
        fs::remove_file(&file)?;
        butler_platform::secure_fs::symlink(&outside, &file)?;
        assert_eq!(question(&s, &project).await?, Value::Null);
        reply(&s, &project, true, &json!([])).await?;
        assert!(!store(&s).exists(), "a linked file saved an answer");
    }
    s.finish().await
}

/// What the person saw is what they answered: the first message asks about the rest.
#[tokio::test]
async fn project_added_and_changed_while_asking_saves_no_trust() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-ADD-STALE").await?;
    project.write(&[project.observer("guard", "Stop", "shown.jsonl")])?;
    let asked = question(&s, &project).await?;
    project.write(&[project.observer("guard", "Stop", "swapped.jsonl")])?;
    reply(&s, &project, true, &asked["hooks"]).await?;
    assert!(!store(&s).exists(), "the old list saved trust");
    let now = question(&s, &project).await?;
    assert!(
        now["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("swapped.jsonl")
    );

    let chat = project.new_chat(&s).await?;
    let turn = s.gw.say_turn(&chat, "First.").await?;
    let shown = card(&s, &chat).await?;
    assert!(
        lines(&shown)[0]["command"]
            .as_str()
            .unwrap()
            .contains("swapped.jsonl")
    );
    assert_eq!(project.ran("swapped.jsonl").len(), 0);
    answer(&s, &chat, &shown, "deny").await?;
    delivered(&s, &chat, &turn).await?;
    assert_eq!(project.ran("swapped.jsonl").len(), 0);
    assert_eq!(project.ran("shown.jsonl").len(), 0);
    s.finish().await
}

/// The folder is always a project's own: a request can't name another.
#[tokio::test]
async fn project_folder_question_takes_only_an_existing_project() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-ADD-ROUTE").await?;
    project.write(&[project.observer("guard", "Stop", "ran.jsonl")])?;
    let unknown = "/projects/no-such-project/folder-trust";
    assert_eq!(s.gw.get(unknown).await?.status, 404);
    let answered =
        s.gw.post(unknown, json!({"trusted":true,"hooks":[]}))
            .await?;
    assert_eq!(answered.status, 404, "{}", answered.text);
    let named =
        s.gw.post(
            &route(&project),
            json!({"trusted":true,"hooks":[],"project_path":s.sandbox.root}),
        )
        .await?;
    assert_eq!(named.status, 400, "{}", named.text);
    assert!(!store(&s).exists());
    s.finish().await
}
