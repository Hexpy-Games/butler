//! Per-computer environment values through the owner API and both remote command paths.
use super::{
    access_tiers::stub::{self, call},
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
use serde_json::json;
use std::{fs, path::Path};

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
        }
        let controls =
            d.s.gw
                .patch(
                    &format!("/sessions/{chat}/controls"),
                    json!({"access_mode":access}),
                )
                .await?;
        assert_eq!(controls.status, 200, "{controls:?}");
        script.rounds.lock().unwrap().insert(prompt.into(), vec![call(
            "probe", "run_command",
            &json!({"command":"printenv E2E_PROBE","summary":"Read a variable","state_effect":"read_only"}),
        )]);
        let (_, turn) = d.s.turn(&chat, prompt).await?;
        assert_eq!(turn_state(&turn), "delivered");
        assert!(
            script
                .requests_for(prompt)
                .iter()
                .flat_map(|request| request["input"].as_array().into_iter().flatten())
                .any(|item| item["type"] == "function_call_output"
                    && item["call_id"] == "probe"
                    && item["output"]
                        .as_str()
                        .is_some_and(|output| output.contains(expected)))
        );
    }
    let listed = d.api.send(Method::GET, "/computers", None, &[]).await?;
    assert_eq!(listed.status, 200);
    assert_eq!(
        listed.data()["computers"][0]["environment"],
        json!(["E2E_PROBE"])
    );
    let registry = fs::read_to_string(d.s.sandbox.data.join("config/computers.json"))?;
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
async fn computer_environment_refuses_blocked_names() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("COMPUTER-ENV-ADD-REFUSAL")?.start().await?;
    let api = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let rejected = api
        .send(
            Method::POST,
            "/computers",
            Some(json!({
                "name":"Remote","address":"127.0.0.1","folder":"~/work",
                "environment":[{"name":"LD_PRELOAD","value":"blocked"}],
            })),
            &[],
        )
        .await?;
    assert_eq!(rejected.status, 400, "{rejected:?}");
    assert_eq!(rejected.error_code(), Some("computer_env_name_reserved"));
    s.finish().await?;

    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let d = deployed_with("COMPUTER-ENV-EDIT-REFUSAL", &[], &[], true).await?;
    let path = format!("/computers/{}", d.id);
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
            json!([{"name":"LD_PRELOAD","value":"blocked"}]),
            "computer_env_name_reserved",
        ),
        (
            json!([{"name":"DYLD_INSERT_LIBRARIES","value":"blocked"}]),
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
    let listed = d.api.send(Method::GET, "/computers", None, &[]).await?;
    assert_eq!(
        listed.data()["computers"][0]["environment"],
        json!(["E2E_PROBE"])
    );
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
