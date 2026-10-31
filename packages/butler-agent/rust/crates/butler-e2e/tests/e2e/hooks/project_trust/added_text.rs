//! What a project hook adds to a turn: only what it says it adds, and labelled as
//! coming from the project.
use super::super::context::prompts;
use super::*;

fn explicit(text: &str) -> String {
    json!({"hookSpecificOutput":{"additionalContext":text}}).to_string()
}

#[tokio::test]
async fn project_hooks_add_only_explicit_text_labelled_as_the_project() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-CONTEXT").await?;
    let chat = project.chat.clone();
    project.write(&[
        project.printing("plain", "UserPromptSubmit", "PLAIN-STDOUT-MARK"),
        project.printing("told", "UserPromptSubmit", &explicit("EXPLICIT-TEXT-MARK")),
    ])?;
    let turn = s.gw.say_turn(&chat, "First.").await?;
    let asked = card(&s, &chat).await?;
    answer(&s, &chat, &asked, "allow").await?;
    delivered(&s, &chat, &turn).await?;

    quiet_turn(&s, &chat, "Second.").await?;
    let prompt = prompts(&s)?
        .into_iter()
        .rfind(|prompt| prompt.contains("Second."))
        .unwrap();
    assert!(prompt.contains("EXPLICIT-TEXT-MARK"), "{prompt}");
    assert!(
        prompt.contains("hook=\"project:told\" scope=project event=UserPromptSubmit>"),
        "{prompt}"
    );
    assert!(!prompt.contains("scope=user"), "{prompt}");
    assert!(!prompt.contains("PLAIN-STDOUT-MARK"), "{prompt}");
    // The run log says why, for whoever wrote the hook.
    let runs = api(&s, Method::GET, "/hooks/runs", None).await?;
    assert!(
        runs.text.contains("project hooks use additionalContext"),
        "{}",
        runs.text
    );
    s.finish().await
}

#[tokio::test]
async fn project_hooks_a_held_session_start_runs_and_its_text_is_dropped()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-HELD-TEXT").await?;
    project.write(&[
        project.printing("start", "SessionStart", &explicit("HELD-START-MARK")),
        project.observer("seen", "SessionStart", "seen.jsonl"),
    ])?;
    let chat = project.new_chat(&s).await?;
    let turn = s.gw.say_turn(&chat, "First.").await?;
    answer(&s, &chat, &card(&s, &chat).await?, "allow").await?;
    delivered(&s, &chat, &turn).await?;
    assert_eq!(project.events("seen.jsonl"), ["SessionStart"]);
    for prompt in prompts(&s)? {
        assert!(!prompt.contains("HELD-START-MARK"), "{prompt}");
    }
    let runs = api(&s, Method::GET, "/hooks/runs", None).await?;
    assert!(
        runs.text.contains("Added text was dropped"),
        "{}",
        runs.text
    );

    // Answered now, so the next chat's SessionStart text joins its first turn.
    let other = project.new_chat(&s).await?;
    quiet_turn(&s, &other, "Next chat.").await?;
    let prompt = prompts(&s)?
        .into_iter()
        .rfind(|prompt| prompt.contains("Next chat."))
        .unwrap();
    assert!(prompt.contains("HELD-START-MARK"), "{prompt}");
    assert!(
        prompt.contains("scope=project event=SessionStart>"),
        "{prompt}"
    );
    s.finish().await
}
