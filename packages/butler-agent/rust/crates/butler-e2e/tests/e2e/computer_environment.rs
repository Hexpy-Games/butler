//! Per-computer environment values through the owner API and both remote command paths.
use super::{
    access_tiers::{
        approve, delivered,
        stub::{self, call},
    },
    computer_account::{Deployed, deployed_with},
    remote_sessions::remote_chat_with_model,
};
use butler_e2e::e2e::{
    HarnessError, fake_chatgpt::FakeChatGptAuthority, gateway::turn_state, scenario::Setup,
    security::AdminClient,
};
use butler_models::models::reset_secret_keys;
use butler_platform::secrets::{SecretKey, isolated_system_secret_present_for_test};
use reqwest::Method;
use serde_json::{Value, json};
use std::{fmt::Write as _, fs, path::Path, time::Duration};

#[tokio::test]
async fn computer_environment_reaches_remote_commands_only_as_names_on_the_main()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    const ORIGINAL: &str = "ce-7f3a9c21-value-a1";
    const REPLACEMENT: &str = "ce-7f3a9c21-value-b2";
    const COMMAND: &str = "printenv PATH E2E_PLAIN E2E_EMPTY E2E_PROBE";
    const TEXT: &str = "\u{feff}# remote\r\n  export\t E2E_PLAIN \t= \" a=b#c\\n$HOME \"\r\nPATH=/custom/bin:/usr/bin:/bin # tools\nE2E_EMPTY=\r";
    let (url, script, server) = stub::start().await?;
    let authority = FakeChatGptAuthority::start().await?;
    let (d, chat) = remote_chat_with_model(
        "COMPUTER-ENV-COMMANDS",
        "full_access",
        &format!("{url}/v1"),
        &authority,
        false,
        true,
    )
    .await?;
    let path = format!("/computers/{}", d.id);
    let mut input = edit_input(&d).await?;
    input["environment_text"] = json!(TEXT);
    for (prompt, access, edit, expected) in [
        (
            "Read the environment value.",
            "full_access",
            Some(json!({"name":"E2E_PROBE","value":ORIGINAL})),
            ORIGINAL,
        ),
        ("Read the value in guided mode.", "auto", None, ORIGINAL),
        (
            "Read the kept value.",
            "auto",
            Some(json!({"name":"E2E_PROBE"})),
            ORIGINAL,
        ),
        (
            "Read the changed value.",
            "auto",
            Some(json!({"name":"E2E_PROBE","value":REPLACEMENT})),
            REPLACEMENT,
        ),
    ] {
        if let Some(entry) = edit {
            input["environment"] = json!([entry]);
            let saved = d
                .api
                .send(Method::PUT, &path, Some(input.clone()), &[])
                .await?;
            assert_eq!(saved.status, 200, "{saved:?}");
            assert_eq!(
                saved.data()["computer"]["environment"],
                json!(["E2E_PROBE"])
            );
            assert!(!saved.text.contains(expected));
            assert_eq!(saved.data()["computer"]["environment_text"], TEXT);
            input.as_object_mut().unwrap().remove("environment_text");
        } else {
            let saved = d
                .api
                .send(Method::PUT, &path, Some(edit_input(&d).await?), &[])
                .await?;
            assert_eq!(saved.status, 200, "{saved:?}");
            assert_eq!(saved.data()["computer"]["environment_text"], TEXT);
            assert_eq!(
                saved.data()["computer"]["environment"],
                json!(["E2E_PROBE"])
            );
        }
        let controls =
            d.s.gw
                .patch(
                    &format!("/sessions/{chat}/controls"),
                    json!({"access_mode":access}),
                )
                .await?;
        assert_eq!(controls.status, 200, "{controls:?}");
        script.rounds.lock().unwrap().insert(
            prompt.into(),
            vec![call(
                "probe",
                "run_command",
                &json!({"command":COMMAND,"summary":"Read a variable","state_effect":"read_only"}),
            )],
        );
        if access == "auto" {
            let id = d.s.gw.say_turn(&chat, prompt).await?;
            let turn =
                d.s.gw
                    .wait_turn(
                        &chat,
                        &id,
                        &[
                            "waiting_for_form",
                            "delivered",
                            "cancelled",
                            "failed",
                            "runtime_fault",
                        ],
                        Duration::from_secs(20),
                    )
                    .await?;
            if turn_state(&turn) == "waiting_for_form" {
                let cards = d.s.gw.approval_requests(&chat).await?;
                assert_eq!(cards.len(), 1);
                assert_eq!(cards[0]["source_turn_id"], id);
                assert_eq!(cards[0]["approval"]["examples"], json!([COMMAND]));
                approve(&d.s, &chat, "allow", None).await?;
                delivered(&d.s, &chat, &id).await?;
            } else {
                assert_eq!(turn_state(&turn), "delivered", "{turn}");
            }
        } else {
            let (_, turn) = d.s.turn(&chat, prompt).await?;
            assert_eq!(turn_state(&turn), "delivered", "{turn}");
        }
        assert!(
            script
                .requests_for(prompt)
                .iter()
                .flat_map(|request| request["input"].as_array().into_iter().flatten())
                .any(|item| item["type"] == "function_call_output"
                    && item["call_id"] == "probe"
                    && item["output"]
                        .as_str()
                        .and_then(|output| serde_json::from_str::<Value>(output).ok())
                        .and_then(|output| output["stdout"].as_str().map(str::to_owned))
                        .is_some_and(|stdout| {
                            let mut lines = stdout.lines();
                            lines
                                .next()
                                .is_some_and(|path| path.starts_with("/custom/bin:/usr/bin:/bin"))
                                && lines.eq([r" a=b#c\n$HOME ", "", expected])
                        }))
        );
    }
    let listed = d.api.send(Method::GET, "/computers", None, &[]).await?;
    assert_eq!(listed.status, 200);
    assert_eq!(listed.data()["computers"][0]["environment_text"], TEXT);
    assert_eq!(
        listed.data()["computers"][0]["environment"],
        json!(["E2E_PROBE"])
    );
    let registry = fs::read_to_string(d.s.sandbox.data.join("config/computers.json"))?;
    let stored: Value = serde_json::from_str(&registry)?;
    assert_eq!(stored["computers"][0]["environment_text"], TEXT);
    for value in [ORIGINAL, REPLACEMENT] {
        assert!(!listed.text.contains(value));
        assert!(!registry.contains(value));
    }
    let mut directories = vec![d.s.sandbox.data.join("logs")];
    while let Some(dir) = directories.pop() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                directories.push(entry.path());
            } else if entry.file_type()?.is_file() {
                let bytes = fs::read(entry.path())?;
                for value in [ORIGINAL, REPLACEMENT] {
                    assert!(
                        !bytes
                            .windows(value.len())
                            .any(|window| window == value.as_bytes())
                    );
                }
            }
        }
    }
    let account = format!("computer_env/{}", d.id);
    let (service, _) = reset_secret_keys(&d.s.sandbox.data)?
        .into_iter()
        .find(|(_, stored)| stored == &account)
        .unwrap();
    let key = SecretKey::new(&service, &account).map_err(std::io::Error::other)?;
    assert!(isolated_system_secret_present_for_test(
        &d.s.sandbox.home,
        &key
    )?);
    let deleted = d.api.send(Method::DELETE, &path, None, &[]).await?;
    assert_eq!(deleted.status, 200, "{deleted:?}");
    assert!(!isolated_system_secret_present_for_test(
        &d.s.sandbox.home,
        &key
    )?);

    let Deployed {
        s,
        remote,
        sshd,
        files,
        ..
    } = d;
    drop((remote, sshd, files, server, authority));
    s.finish().await
}

#[tokio::test]
async fn computer_environment_add_validation_is_line_aware() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("COMPUTER-ENV-ADD-REFUSAL")?.start().await?;
    let api = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut input = json!({
        "name":"Remote","address":"127.0.0.1","folder":"~/work",
        "environment":[{"name":"SECRET","value":"example"}],
    });
    let mut too_many = String::new();
    for index in 0..64 {
        writeln!(&mut too_many, "V{index}=").unwrap();
    }
    for (text, code, line) in [
        (
            "# comment\n\nBROKEN".into(),
            "computer_env_line_invalid",
            Some(3),
        ),
        (
            "BUTLER_X=value".into(),
            "computer_env_name_reserved",
            Some(1),
        ),
        (
            "# comment\nTMPDIR=/tmp/example".into(),
            "computer_env_name_reserved",
            Some(2),
        ),
        (
            "# comment\nSECRET=plain".into(),
            "computer_env_name_secret",
            Some(2),
        ),
        (
            "A=1\nexport A=2".into(),
            "computer_env_name_duplicate",
            Some(2),
        ),
        ("A=\"".into(), "computer_env_line_invalid", Some(1)),
        ("A='bad\"".into(), "computer_env_line_invalid", Some(1)),
        ("A\u{3000}=bad".into(), "computer_env_line_invalid", Some(1)),
        ("A=x\ry".into(), "computer_env_line_invalid", Some(1)),
        (
            format!("A={}", "한".repeat(10_923)),
            "computer_env_line_invalid",
            Some(1),
        ),
        (" ".repeat(64 * 1024 + 1), "computer_env_too_large", None),
        (too_many, "computer_env_too_many", None),
    ] {
        input["environment_text"] = json!(text);
        let rejected = api
            .send(Method::POST, "/computers", Some(input.clone()), &[])
            .await?;
        assert_eq!(rejected.status, 400, "{rejected:?}");
        assert_eq!(rejected.error_code(), Some(code));
        assert_eq!(rejected.body["error"].get("line").is_some(), line.is_some());
        assert_eq!(rejected.body["error"]["line"], json!(line));
    }
    input["environment_text"] = json!(format!("PLAIN={}", "x".repeat(32 * 1024)));
    input["environment"] = json!(
        (0..7)
            .map(|i| json!({"name":format!("SECRET_{i}"),"value":"x".repeat(32 * 1024)}))
            .collect::<Vec<_>>()
    );
    let rejected = api
        .send(Method::POST, "/computers", Some(input.clone()), &[])
        .await?;
    assert_eq!(rejected.status, 400, "{rejected:?}");
    assert_eq!(rejected.error_code(), Some("computer_env_too_large"));
    assert!(rejected.body["error"].get("line").is_none());

    input["environment_text"] = json!("");
    input["environment"] = json!([{"name":"BUTLER_X","value":"blocked"}]);
    let rejected = api
        .send(Method::POST, "/computers", Some(input), &[])
        .await?;
    assert_eq!(rejected.status, 400, "{rejected:?}");
    assert_eq!(rejected.error_code(), Some("computer_env_name_reserved"));
    assert!(rejected.body["error"].get("line").is_none());
    let listed = api.send(Method::GET, "/computers", None, &[]).await?;
    assert_eq!(listed.data()["computers"], json!([]));
    s.finish().await
}

#[tokio::test]
async fn computer_environment_refuses_invalid_edits() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let d = deployed_with("COMPUTER-ENV-EDIT-REFUSAL", &[], &[], true).await?;
    let path = format!("/computers/{}", d.id);
    let mut input = edit_input(&d).await?;
    input["environment_text"] = json!("PLAIN=before");
    input["environment"] = json!([{"name":"E2E_PROBE","value":"ce-7f3a9c21-value-a1"}]);
    let saved = d
        .api
        .send(Method::PUT, &path, Some(input.clone()), &[])
        .await?;
    assert_eq!(saved.status, 200, "{saved:?}");
    for (environment, code) in [
        (
            json!([{"name":"BUTLER_X","value":"blocked"}]),
            "computer_env_name_reserved",
        ),
        (
            json!([{"name":"1BAD","value":"invalid"}]),
            "computer_env_name_invalid",
        ),
        (json!([{"name":"NEW"}]), "computer_env_value_required"),
        (
            json!([{"name":"NEW","value":"first\nsecond"}]),
            "computer_env_value_invalid",
        ),
        (
            json!(
                (0..8)
                    .map(|i| json!({"name":format!("VAR_{i}"),"value":"a".repeat(32 * 1024)}))
                    .collect::<Vec<_>>()
            ),
            "computer_env_too_large",
        ),
    ] {
        input["environment"] = environment;
        let refused = d
            .api
            .send(Method::PUT, &path, Some(input.clone()), &[])
            .await?;
        assert_eq!(refused.status, 400, "{refused:?}");
        assert_eq!(refused.error_code(), Some(code));
    }
    input.as_object_mut().unwrap().remove("environment");
    input["environment_text"] = json!("# comment\nE2E_PROBE=collision");
    let refused = d
        .api
        .send(Method::PUT, &path, Some(input.clone()), &[])
        .await?;
    assert_eq!(refused.status, 400);
    assert_eq!(refused.error_code(), Some("computer_env_name_secret"));
    assert_eq!(refused.body["error"]["line"], 2);

    let listed = d.api.send(Method::GET, "/computers", None, &[]).await?;
    assert_eq!(
        listed.data()["computers"][0]["environment"],
        json!(["E2E_PROBE"])
    );
    assert_eq!(
        listed.data()["computers"][0]["environment_text"],
        "PLAIN=before"
    );

    input["environment"] = json!([]);
    let saved = d
        .api
        .send(Method::PUT, &path, Some(input.clone()), &[])
        .await?;
    assert_eq!(saved.status, 200, "{saved:?}");
    assert_eq!(saved.data()["computer"]["environment"], json!([]));
    assert_eq!(
        saved.data()["computer"]["environment_text"],
        input["environment_text"]
    );

    input["environment_text"] = json!(" \t\r\n\u{3000}");
    let cleared = d.api.send(Method::PUT, &path, Some(input), &[]).await?;
    assert_eq!(cleared.status, 200, "{cleared:?}");
    assert_eq!(cleared.data()["computer"]["environment_text"], "");
    let Deployed {
        s,
        remote,
        sshd,
        files,
        ..
    } = d;
    drop((remote, sshd, files));
    s.finish().await
}

async fn edit_input(d: &Deployed) -> Result<Value, HarnessError> {
    let listed = d.api.send(Method::GET, "/computers", None, &[]).await?;
    let mut input = json!({});
    for key in [
        "name",
        "address",
        "port",
        "key_file",
        "folder",
        "model_source",
    ] {
        input[key] = listed.data()["computers"][0][key].clone();
    }
    Ok(input)
}
