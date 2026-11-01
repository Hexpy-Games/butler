//! An answer covers what its card listed. A file that changed while the card waited was
//! never seen, so trusting the old list runs none of it and saves nothing.
use super::*;

fn store(s: &Scenario) -> std::path::PathBuf {
    s.sandbox.data.join("auth/project-hook-trust.json")
}

/// A turn waiting on the card of one hook.
async fn waiting(s: &Scenario, project: &Project) -> Result<(String, Value), HarnessError> {
    project.write(&[project.observer("guard", "PreToolUse", "shown.jsonl")])?;
    let turn = s.gw.say_turn(&project.chat, "Check.").await?;
    let shown = card(s, &project.chat).await?;
    let command = &lines(&shown)[0]["command"];
    assert!(command.as_str().unwrap().contains("shown.jsonl"));
    Ok((turn, shown))
}

#[tokio::test]
async fn project_hooks_changed_while_the_card_waits_get_their_own_card() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-STALE").await?;
    let chat = project.chat.clone();
    let (turn, shown) = waiting(&s, &project).await?;
    project.write(&[project.observer("guard", "PreToolUse", "swapped.jsonl")])?;
    answer(&s, &chat, &shown, "allow").await?;

    // Asked about what is there now, with nothing run and nothing saved.
    let again = next_card(&s, &chat, &shown).await?;
    let command = &lines(&again)[0]["command"];
    assert!(command.as_str().unwrap().contains("swapped.jsonl"));
    assert_eq!(project.ran("shown.jsonl").len(), 0);
    assert_eq!(project.ran("swapped.jsonl").len(), 0);
    assert!(!store(&s).exists(), "the old answer saved trust");

    answer(&s, &chat, &again, "allow").await?;
    delivered(&s, &chat, &turn).await?;
    assert_eq!(project.ran("swapped.jsonl").len(), 1);
    assert_eq!(project.ran("shown.jsonl").len(), 0);
    assert!(store(&s).exists());
    s.finish().await
}

/// With nothing left to ask about, the turn goes on, and the next file asks.
#[tokio::test]
async fn project_hooks_gone_while_the_card_waits_save_no_trust() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-STALE-GONE").await?;
    let chat = project.chat.clone();
    let file = project.root.join(".butler/hooks.json");
    let empty = json!({"version":1,"hooks":[]}).to_string();
    let mut idle = project.observer("guard", "PreToolUse", "shown.jsonl");
    idle["enabled"] = json!(false);
    let turned_off = json!({"version":1,"hooks":[idle]}).to_string();
    for content in [
        Some("{broken"),
        Some(empty.as_str()),
        Some(turned_off.as_str()),
        None,
    ] {
        let (turn, shown) = waiting(&s, &project).await?;
        match content {
            Some(content) => fs::write(&file, content)?,
            None => fs::remove_file(&file)?,
        }
        answer(&s, &chat, &shown, "allow").await?;
        delivered(&s, &chat, &turn).await?;
        assert_eq!(s.gw.approval_requests(&chat).await?, Vec::<Value>::new());
        assert!(
            !store(&s).exists(),
            "{content:?}: the old answer saved trust"
        );
    }
    assert_eq!(project.ran("shown.jsonl").len(), 0);
    s.finish().await
}

/// Refusing does not depend on what the file says.
#[tokio::test]
async fn project_hooks_refusing_a_changed_file_still_counts() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-STALE-DENY").await?;
    let chat = project.chat.clone();
    let (turn, shown) = waiting(&s, &project).await?;
    project.write(&[project.observer("guard", "PreToolUse", "swapped.jsonl")])?;
    answer(&s, &chat, &shown, "deny").await?;
    delivered(&s, &chat, &turn).await?;
    quiet_turn(&s, &chat, "Next.").await?;
    assert_eq!(project.ran("swapped.jsonl").len(), 0);
    s.finish().await
}

/// An answer that could not be saved runs nothing. The same list has had its answer, so
/// this turn goes on; a list the user has not seen is asked about, and a later turn asks.
#[tokio::test]
async fn project_hooks_answer_that_cannot_be_saved_runs_nothing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-STALE-SAVE").await?;
    let chat = project.chat.clone();
    // A folder at the store's path makes every write of it fail.
    fs::create_dir_all(store(&s))?;

    let (turn, shown) = waiting(&s, &project).await?;
    answer(&s, &chat, &shown, "allow").await?;
    delivered(&s, &chat, &turn).await?;
    assert_eq!(s.gw.approval_requests(&chat).await?, Vec::<Value>::new());
    assert_eq!(project.ran("shown.jsonl").len(), 0);

    let (turn, shown) = waiting(&s, &project).await?;
    project.write(&[project.observer("guard", "PreToolUse", "swapped.jsonl")])?;
    answer(&s, &chat, &shown, "allow").await?;
    let again = next_card(&s, &chat, &shown).await?;
    assert!(
        lines(&again)[0]["command"]
            .as_str()
            .unwrap()
            .contains("swapped.jsonl")
    );
    answer(&s, &chat, &again, "deny").await?;
    delivered(&s, &chat, &turn).await?;
    assert_eq!(project.ran("shown.jsonl").len(), 0);
    assert_eq!(project.ran("swapped.jsonl").len(), 0);
    s.finish().await
}

/// PowerShell ends a single-quoted string at any of its four single quotes.
#[tokio::test]
async fn project_hook_values_stay_one_powershell_string() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    assert_eq!(
        command_sandbox::powershell_literal("a'b\u{2018}c\u{2019}; calc; \u{201a}d\u{201b}e"),
        "'a''b\u{2018}\u{2018}c\u{2019}\u{2019}; calc; \u{201a}\u{201a}d\u{201b}\u{201b}e'"
    );
    Ok(())
}

/// In a mode that asks, a write nobody may make is refused without asking first.
#[tokio::test]
async fn project_hooks_store_and_env_are_refused_before_any_card() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-STORE-ASK").await?;
    s.patch_settings(json!({"access_mode":"ask_first"}), "mode")
        .await?;
    s.provider()?.set_chat_responder(stub::forge_trust);
    let chat = project.new_chat(&s).await?;
    for target in [s.sandbox.data.join(".env"), store(&s)] {
        let prompt = format!("Write {{}} to <path>{}</path>", target.display());
        quiet_turn(&s, &chat, &prompt).await?;
        let told = s.provider()?.requests();
        let told = told.last().unwrap()["input"].to_string();
        assert!(told.contains("credential_store_blocked"), "{told}");
        assert!(
            told.contains("Ask the user to change this in Settings"),
            "{told}"
        );
    }
    s.finish().await
}
