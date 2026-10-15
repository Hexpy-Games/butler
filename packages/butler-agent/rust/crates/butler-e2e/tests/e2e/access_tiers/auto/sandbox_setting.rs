use super::*;

/// A live preference change gates the next command in an existing Auto chat.
pub(super) async fn verify(
    s: &Scenario,
    chat: &str,
    script: &Arc<Script>,
    project: &Path,
) -> Result<(), HarnessError> {
    assert_eq!(s.gw.settings().await?["command_sandbox_enabled"], true);
    let reply =
        s.gw.patch("/settings", json!({"command_sandbox_enabled":false}))
            .await?;
    assert_eq!(reply.status, 200);
    assert_eq!(s.gw.settings().await?["command_sandbox_enabled"], false);
    let prompt = "Make the disabled sandbox marker.";
    script.rounds.lock().unwrap().insert(
        prompt.into(),
        vec![
            call(
                "describe",
                "tool_describe",
                &json!({"ids":["native:list_tool_capabilities"]}),
            ),
            call(
                "caps",
                "tool_call",
                &json!({"id":"native:list_tool_capabilities","arguments":{"category":"command"}}),
            ),
            mutation("disabled", "echo disabled > src/disabled.txt"),
        ],
    );
    let id = paused(s, chat, prompt).await?;
    assert_counts(s, &id, 1, 1)?;
    assert!(!project.join("src/disabled.txt").exists());
    approve(s, chat, "deny").await?;
    delivered(s, chat, &id).await?;
    assert!(!project.join("src/disabled.txt").exists());
    let output = outputs(s, chat, &id, script, prompt).await?;
    assert!(
        output.iter().any(|v| v.contains("disabled_by_user")),
        "{output:?}"
    );
    let reply =
        s.gw.patch("/settings", json!({"command_sandbox_enabled":true}))
            .await?;
    assert_eq!(reply.status, 200);
    assert_eq!(s.gw.settings().await?["command_sandbox_enabled"], true);
    eprintln!("PERM-02 sandbox setting: off=asked marker=absent on=restored without restart");
    Ok(())
}
