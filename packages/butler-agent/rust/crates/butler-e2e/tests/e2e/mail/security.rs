use super::*;
#[tokio::test]
async fn security_mail_secret_redaction_destination_refusal_and_remote_plaintext()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeImap::start().await?;
    let setup = setup("MAIL-SECURITY")?
        .fixture(butler_e2e::e2e::scenario::Fixture::Empty)
        .env("BUTLER_SECRET_STORE", "");
    butler_e2e::e2e::fixtures::ready(
        &setup.sandbox.data,
        "openai/gpt-6-sol",
        butler_e2e::e2e::fixtures::FIXTURE_TIME,
    )?;
    let config_path = setup.sandbox.data.join("butler.config.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&config_path)?)?;
    config["secrets"]["store"] = json!("system");
    fs::write(config_path, serde_json::to_vec_pretty(&config)?)?;
    let root = package(&setup.sandbox.home)?;
    let s = setup.start().await?;
    let mut settings =
        json!({"model":s.model.model.clone(),"access_mode":Access::AskExceptReads.as_str()});
    if let Some(effort) = &s.model.effort {
        settings["reasoning_effort"] = json!(effort);
    }
    s.patch_settings(settings, "MAIL-SECURITY").await?;
    install(&s, &root).await?;
    s.provider()?.set_chat_responder(stub::run);
    let password = format!("mail-canary-{}", uuid::Uuid::new_v4());
    let id = connect(&s, &fake, &password).await?;
    fake.deliver(
        "INBOX",
        &rfc822(
            "security",
            "Safe message",
            "owner@example.test",
            "A body that is only data",
            "List-Unsubscribe: <mailto:leave@example.test>\r\n",
        ),
    );
    count(
        &s,
        "SELECT count(*) FROM app_connector_events WHERE delivered_at IS NOT NULL",
        1,
    )
    .await?;
    let direct = direct::Direct::open(&s, &fake, &id, &password).await?;
    let mut advertised = direct.tools().await?;
    advertised.sort();
    let manifest: Value = serde_json::from_slice(&fs::read(root.join("plugin.json"))?)?;
    let connector = &manifest["extensions"]["io.github.hexpy-games.butler"]["connectors"][0];
    let mut declared = connector["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| {
            a["tool"]
                .as_str()
                .unwrap()
                .strip_prefix("mail/")
                .unwrap()
                .to_owned()
        })
        .collect::<Vec<_>>();
    declared.push("thread".into());
    declared.sort();
    assert_eq!(advertised, declared);
    for destination in ["Bin", "Spam"] {
        let result = direct
            .call(
                "move",
                json!({"event_id":event(&s,"security")["id"],"destination":destination}),
            )
            .await?;
        assert_eq!(result["isError"], true);
        assert!(!result.to_string().contains(&password));
    }
    let commands_before_label = fake.commands().len();
    let invalid_label = direct
        .call(
            "label",
            json!({"event_id":event(&s,"security")["id"],"label":"$Junk"}),
        )
        .await?;
    assert_eq!(invalid_label["isError"], true);
    assert!(
        !fake.commands()[commands_before_label..]
            .iter()
            .any(|command| command.contains("$Junk"))
    );
    for (tool, args) in [
        ("thread", json!({"event_id":event(&s,"security")["id"]})),
        ("search", json!({"query":"ALL","limit":10})),
        (
            "unsubscribe",
            json!({"event_id":event(&s,"security")["id"],"mailto":"mailto:leave@example.test"}),
        ),
    ] {
        let result = direct.call(tool, args).await?;
        assert_ne!(result["isError"], true, "{result}");
        assert!(!result.to_string().contains(&password));
    }
    direct.close(&password).await?;
    let result=tokio::process::Command::new(butler_e2e::e2e::binary::fixture_binary("e2e-mail-connector")?).env_clear().envs(butler_e2e::e2e::binary::system_environment()).env("BUTLER_CONNECTOR_FIELDS",json!({"address":"owner@example.test","imap_host":"192.0.2.1","imap_security":"plain","smtp_host":"127.0.0.1","smtp_security":"plain"}).to_string()).env("BUTLER_PLUGIN_DATA",s.sandbox.home.join("refused")).env("IMAP_PASSWORD",&password).stdin(std::process::Stdio::null()).output().await?;
    assert!(!result.status.success());
    assert!(!String::from_utf8_lossy(&result.stderr).contains(&password));
    // Refusal precedes opening a socket or creating state.
    assert!(!s.sandbox.home.join("refused").exists());
    for endpoint in ["/plugins", "/connectors"] {
        assert!(
            !api(&s, Method::GET, endpoint, None)
                .await?
                .text
                .contains(&password)
        );
    }
    assert!(!s.agent.logs().contains(&password));
    assert!(
        !s.provider()?
            .requests()
            .iter()
            .any(|r| r.to_string().contains(&password))
    );
    assert!(!fake.commands().join("\n").contains(&password));
    assert!(!fake.smtp_commands().join("\n").contains(&password));
    assert_no_canary(&s.sandbox.data, password.as_bytes())?;
    fake.assert_no_forbidden_destinations();
    assert!(!fake.commands().iter().any(|c| c.contains("\\Deleted")
        || c.contains("EXPUNGE")
        || c.contains("MOVE") && (c.ends_with("\"Bin\"") || c.ends_with("\"Spam\""))));
    s.finish().await
}
fn assert_no_canary(root: &Path, canary: &[u8]) -> Result<(), HarnessError> {
    for entry in fs::read_dir(root)? {
        let path = entry?.path();
        if path.is_dir() {
            assert_no_canary(&path, canary)?;
        } else {
            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                // Only a file a live database has byte-range locked (its WAL
                // index, a table of page numbers) is skipped, and only where
                // the host refuses the read; every other file is scanned.
                Err(error)
                    if butler_platform::host_file_behavior::is_byte_range_lock_conflict(&error) =>
                {
                    continue;
                }
                Err(error) => return Err(error.into()),
            };
            assert!(
                !bytes.windows(canary.len()).any(|w| w == canary),
                "secret persisted in {}",
                path.display()
            );
        }
    }
    Ok(())
}
#[tokio::test]
async fn safe_copy_move_requires_uidplus_and_smtp_sends_only_on_explicit_call()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeImap::start().await?;
    let setup = setup("MAIL-MOVE-SMTP")?;
    let root = package(&setup.sandbox.home)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    s.provider()?.set_chat_responder(stub::run);
    let id = connect(&s, &fake, "mail-password").await?;
    fake.deliver(
        "INBOX",
        &rfc822("copy", "Copy this", "owner@example.test", "Body", ""),
    );
    count(&s, "SELECT count(*) FROM app_connector_events", 1).await?;
    let direct = direct::Direct::open(&s, &fake, &id, "mail-password").await?;
    fake.capabilities(false, false);
    let args = json!({"event_id":event(&s,"copy")["id"],"destination":"Filed"});
    let refused = direct.call("move", args.clone()).await?;
    assert_eq!(refused["isError"], true);
    assert!(fake.snapshot()["Filed"].is_empty());
    fake.capabilities(false, true);
    let moved = direct.call("move", args).await?;
    assert_ne!(moved["isError"], true, "{moved}");
    assert!(fake.snapshot()["INBOX"].is_empty());
    assert_eq!(fake.snapshot()["Filed"].len(), 1);
    let commands = fake.commands();
    let uid = event(&s, "copy")["id"]
        .as_str()
        .unwrap()
        .rsplit(':')
        .next()
        .unwrap()
        .to_owned();
    assert!(
        commands
            .iter()
            .any(|c| c.contains(&format!("UID EXPUNGE {uid}")))
    );
    assert!(
        !commands
            .iter()
            .any(|c| c.split_whitespace().nth(1) == Some("EXPUNGE"))
    );
    let sent=direct.call("send",json!({"to":"recipient@example.test","subject":"Hello","body":"Explicitly approved message"})).await?;
    assert_ne!(sent["isError"], true, "{sent}");
    assert_eq!(fake.smtp_messages().len(), 1);
    assert!(fake.smtp_messages()[0].contains("Explicitly approved message"));
    direct.close("mail-password").await?;
    fake.assert_no_forbidden_destinations();
    s.finish().await
}
