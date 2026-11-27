use super::stub::{self, call};
use super::{approve, assert_counts, delivered, outputs, paused};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Access, Setup},
};
use serde_json::json;

#[tokio::test]
async fn deny_rule_blocks_unparsed_commands_in_full_access() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("APPROVAL-DENY-UNPARSED")?
        .access(Access::AskExceptReads)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let parent = setup.sandbox.home.join("project");
    std::fs::create_dir(&parent)?;
    let mut s = setup.start().await?;
    let chat = crate::project_workspace::bind_project(&mut s, &parent).await?;
    let project = parent.join("작업 Project");
    std::fs::write(project.join("a.txt"), "a")?;
    std::fs::write(project.join("b.txt"), "b")?;
    script.rounds.lock().unwrap().insert(
        "Remove file a.".into(),
        vec![call(
            "a",
            "run_command",
            &json!({"command":"rm a.txt","state_effect":"mutation","summary":"Remove file"}),
        )],
    );
    let turn = paused(&s, &chat, "Remove file a.").await?;
    approve(&s, &chat, "deny", Some("always")).await?;
    delivered(&s, &chat, &turn).await?;
    let controls =
        s.gw.patch(
            &format!("/sessions/{chat}/controls"),
            json!({"access_mode":"full_access"}),
        )
        .await?;
    assert_eq!(controls.status, 200, "{}", controls.text);
    let commands = [
        r#"cmd /c "rm b.txt""#,
        "cmd /c cmd /c rm b.txt",
        "rm,b.txt",
        r"C:\Windows\System32\cmd.exe /c rm b.txt",
    ];
    let batch: Vec<_> = commands
        .into_iter()
        .enumerate()
        .map(|(index, command)| {
            call(
                &format!("b-{index}"),
                "run_command",
                &json!({"command":command,"state_effect":"mutation","summary":"Remove file"}),
            )
        })
        .collect();
    let prompt = "Remove file b.";
    script
        .rounds
        .lock()
        .unwrap()
        .insert(prompt.into(), vec![json!(batch)]);
    let turn = s.gw.say_turn(&chat, prompt).await?;
    delivered(&s, &chat, &turn).await?;
    assert_counts(&s, &turn, 0, 0)?;
    let output = outputs(&s, &chat, &turn, &script, prompt).await?;
    assert_eq!(output.len(), 4);
    assert!(output.iter().all(|entry| entry.contains("denied_by_rule")));
    assert!(project.join("b.txt").is_file());
    s.finish().await?;
    server.abort();
    Ok(())
}
