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
    low_risk_asks(s, chat, script, "disabled_by_user").await?;
    unreadable_asks(s, chat, script).await?;
    let reply =
        s.gw.patch("/settings", json!({"command_sandbox_enabled":true}))
            .await?;
    assert_eq!(reply.status, 200);
    assert_eq!(s.gw.settings().await?["command_sandbox_enabled"], true);
    eprintln!("PERM-02 sandbox setting: off=asked marker=absent on=restored without restart");
    Ok(())
}

/// Low risk never bypasses a user-disabled or unreadable sandbox preference.
async fn low_risk_asks(
    s: &Scenario,
    chat: &str,
    script: &Arc<Script>,
    reason: &str,
) -> Result<(), HarnessError> {
    for command in ["ls", "cat a.txt"] {
        let prompt = format!("Run {command} with {reason}.");
        script.rounds.lock().unwrap().insert(
            prompt.clone(),
            vec![
                call("describe", "tool_describe", &json!({"ids":["native:list_tool_capabilities"]})),
                call("caps", "tool_call", &json!({"id":"native:list_tool_capabilities","arguments":{"category":"command"}})),
                mutation("low-risk", command),
            ],
        );
        let id = paused(s, chat, &prompt).await?;
        assert_counts(s, &id, 1, 1)?;
        approve(s, chat, "deny").await?;
        delivered(s, chat, &id).await?;
        assert_counts(s, &id, 1, 0)?;
        let output = outputs(s, chat, &id, script, &prompt).await?;
        assert!(output.iter().any(|v| v.contains(reason)), "{output:?}");
        assert!(
            !output.iter().any(|v| v.contains("project-marker")),
            "denied command executed: {output:?}"
        );
    }
    eprintln!("PERM-02 sandbox setting: {reason} low_risk_mutations=asked denied=2");
    Ok(())
}

async fn unreadable_asks(
    s: &Scenario,
    chat: &str,
    script: &Arc<Script>,
) -> Result<(), HarnessError> {
    // A valid settings object with an unreadable boolean exercises the actual
    // SQLite reader error without breaking unrelated gateway settings readers.
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    db.busy_timeout(Duration::from_secs(5))?;
    let original: String = db.query_row(
        "SELECT value_json FROM app_settings WHERE key='settings'",
        [],
        |row| row.get(0),
    )?;
    db.execute("UPDATE app_settings SET value_json=json_set(value_json, '$.command_sandbox_enabled', 'unreadable') WHERE key='settings'", [])?;
    let result = low_risk_asks(s, chat, script, "settings_unavailable").await;
    db.execute(
        "UPDATE app_settings SET value_json=?1 WHERE key='settings'",
        [&original],
    )?;
    result
}
