//! Public chat regression for hosts without read-only command isolation.
use super::observation_stub as provider;
use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Access, Setup, accepted_turn_id, turn_timeout},
};
use serde_json::json;
use std::time::{Duration, Instant};

fn listing_command() -> &'static str {
    if butler_platform::command_sandbox::POSIX_SHELL {
        "printf 'registry_downloads=Downloads\\n'; ls -1 \"$HOME/Downloads\""
    } else {
        r#"$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'; $path = Get-ItemPropertyValue -LiteralPath $key -Name '{374DE290-123F-4565-9164-39C4925E467B}'; Write-Output ('registry_downloads=' + $path); Get-ChildItem -LiteralPath "$env:USERPROFILE\Downloads" | Sort-Object Name | Select-Object -ExpandProperty Name"#
    }
}

async fn run(access: Access, protected: Option<&str>) -> Result<(), HarnessError> {
    let started = Instant::now();
    let setup = Setup::new("OBSERVATION")?;
    let downloads = setup.sandbox.home.join("Downloads");
    std::fs::create_dir_all(&downloads)?;
    std::fs::write(downloads.join("보고서.txt"), "document")?;
    std::fs::write(downloads.join("사진.png"), "image")?;
    let nested = downloads.join("nested");
    std::fs::create_dir_all(&nested)?;
    std::fs::write(nested.join("must-not-list.txt"), "private")?;
    let command = protected.map_or_else(
        || listing_command().to_owned(),
        |target| {
            let path = match target {
                "data" => setup.sandbox.data.join("canary.txt"),
                _ => setup.sandbox.home.join(".ssh/id_ed25519"),
            };
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "protected-canary").unwrap();
            if butler_platform::command_sandbox::POSIX_SHELL {
                format!("cat '{}'", path.display())
            } else {
                format!("Get-Content -LiteralPath '{}'", path.display())
            }
        },
    );
    let refused = protected == Some("credentials");
    let (url, script, server) = provider::start(&command).await?;
    let local = setup.sandbox.home.join("AppData/Local");
    let roaming = setup.sandbox.home.join("AppData/Roaming");
    std::fs::create_dir_all(&local)?;
    std::fs::create_dir_all(&roaming)?;
    let setup = setup
        .env("LOCALAPPDATA", local.display().to_string())
        .env("APPDATA", roaming.display().to_string())
        .stub_cassette(provider::cassette()?)
        .access(access)
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("USERPROFILE", setup_home(&downloads))
        .env("BUTLER_SECRET_STORE", "file")
        .env("BUTLER_PLATFORM_SYSTEM_SECRETS", "0")
        .env("BUTLER_APP_DISABLE_SHELL_REGISTRATION", "1");
    let s = setup.start().await?;
    let accepted = s.gw.say("general", super::stub::PROMPT).await?;
    let id = accepted_turn_id(&accepted)?;
    // Permission-tiers D1/R1: every normal-chat command asks in AskAlways,
    // including commands the executor will subsequently refuse as protected.
    if access == Access::AskAlways {
        approve_exact(&s, &id, &command).await?;
    }
    let turn =
        s.gw.wait_terminal("general", &id, Duration::from_secs(turn_timeout()))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let requests = script.requests.lock().unwrap().clone();
    assert!(
        !requests
            .iter()
            .flat_map(provider::outputs)
            .any(|v| v["error"].is_object()),
        "read-only observation never requires Work/Plan effect repair"
    );
    let output = requests
        .iter()
        .rev()
        .flat_map(provider::outputs)
        .find(|v| v["command"] == command)
        .expect("model gets structured command result");
    if refused {
        assert_eq!(output["error"], "protected_path", "{output}");
        assert!(
            !requests
                .last()
                .unwrap()
                .to_string()
                .contains("protected-canary")
        );
        assert_eq!(
            s.gw.approval_requests("general").await?,
            [] as [serde_json::Value; 0]
        );
    } else if protected == Some("data") {
        assert_eq!(output["exit_code"], 0, "{output}");
        assert_eq!(
            output["stdout"].as_str().unwrap().trim(),
            "protected-canary"
        );
    } else {
        assert_eq!(output["exit_code"], 0, "{output}");
        assert_eq!(output["sandbox"], "unisolated", "{output}");
        let stdout = output["stdout"].as_str().unwrap();
        assert!(stdout.contains("registry_downloads="));
        let mut names: Vec<_> = stdout.lines().skip(1).map(str::trim).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["nested", "보고서.txt", "사진.png"]);
        assert!(!stdout.contains("must-not-list"));
        assert_eq!(
            std::fs::read_to_string(downloads.join("보고서.txt"))?,
            "document"
        );
        assert_eq!(
            std::fs::read_to_string(downloads.join("사진.png"))?,
            "image"
        );
        assert_eq!(std::fs::read_dir(&downloads)?.count(), 3);
        let messages = s.gw.messages("general").await?;
        assert!(
            messages
                .iter()
                .any(|m| m["role"] == "assistant" && m["text"] == super::stub::ANSWER)
        );
        if access == Access::FullAccess {
            assert_eq!(
                s.gw.approval_requests("general").await?,
                [] as [serde_json::Value; 0]
            );
        }
    }
    eprintln!(
        "OBSERVATION {access:?} protected={protected:?}: {} in {:?}",
        if refused {
            "protected path refused without approval or content"
        } else {
            "registry/non-recursive listing/model result/plan verified"
        },
        started.elapsed()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

fn setup_home(downloads: &std::path::Path) -> String {
    downloads.parent().unwrap().display().to_string()
}

pub(super) async fn approve_exact(
    s: &butler_e2e::e2e::scenario::Scenario,
    id: &str,
    command: &str,
) -> Result<(), HarnessError> {
    let turn =
        s.gw.wait_turn(
            "general",
            id,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(turn_timeout()),
        )
        .await?;
    assert_eq!(turn_state(&turn), "waiting_for_form", "{turn}");
    let requests = s.gw.approval_requests("general").await?;
    assert_eq!(requests.len(), 1, "one exact command approval");
    let card = requests
        .iter()
        .find(|r| r["source_turn_id"] == id && r["approval"]["action_kind"] == "run_command")
        .expect("approval card");
    assert_eq!(card["approval"]["examples"], json!([command]));
    assert_eq!(card["approval"]["command_access"], "read_only_unisolated");
    let messages = s.gw.messages("general").await?;
    for row in butler_e2e::e2e::gateway::tool_rows(&messages, id) {
        let text = s.gw.operation_output(id, &row).await.unwrap_or_default();
        assert!(!text.contains("registry_downloads="), "ran before Allow");
        assert!(!text.contains("보고서.txt"), "ran before Allow");
        assert!(!text.contains("protected-canary"), "read before Allow");
    }
    let reference = card["request_ref"].as_str().unwrap();
    let allowed =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(allowed.status, 202, "{}", allowed.text);
    Ok(())
}

#[tokio::test]
async fn observation_ask_first_approves_exact_command_then_lists_downloads()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::READ_ONLY_SANDBOX,
        "host has read-only sandbox"
    );
    run(Access::AskAlways, None).await
}

#[tokio::test]
async fn observation_full_access_lists_downloads_without_approval() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::READ_ONLY_SANDBOX,
        "host has read-only sandbox"
    );
    run(Access::FullAccess, None).await
}

#[tokio::test]
async fn observation_data_uses_normal_approval_and_credentials_stay_refused()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::READ_ONLY_SANDBOX,
        "host has read-only sandbox"
    );
    for access in [Access::AskAlways, Access::FullAccess] {
        for target in ["data", "credentials"] {
            run(access, Some(target)).await?;
        }
    }
    Ok(())
}
