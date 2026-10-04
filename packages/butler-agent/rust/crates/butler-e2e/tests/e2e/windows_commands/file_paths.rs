//! Absolute paths outside a general chat's data-folder workspace, through model tool rounds.
use super::capability_stub::{self as provider, Case};
use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Access, Setup, accepted_turn_id},
};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};

fn cases(home: &Path, installation: &Path) -> Vec<Case> {
    let case = |tool, args| Case {
        tool,
        args,
        refused: false,
    };
    vec![
        case(
            "list_files",
            json!({"root":home.join("Downloads"),"max_depth":1,"max_results":1000}),
        ),
        case(
            "read_file",
            json!({"requests":[{"path":home.join("Documents/보고서.txt")}]}),
        ),
        case(
            "write_file",
            json!({"path":home.join("Desktop/새 파일.txt"),"content":"처음 내용\n","overwrite":false}),
        ),
        case(
            "edit_file",
            json!({"path":home.join("Desktop/새 파일.txt"),"old_text":"처음 내용","new_text":"수정 내용"}),
        ),
        case(
            "read_file",
            json!({"requests":[{"path":home.join("Desktop/새 파일.txt"),"max_bytes":5}]}),
        ),
        case(
            "list_files",
            json!({"root":home.join("Downloads"),"max_results":1}),
        ),
        case(
            "write_file",
            json!({"path":home.join(".ssh/fixture.key"),"content":"OS accessible fixture"}),
        ),
        case(
            "write_file",
            json!({"path":"../Downloads/relative.txt","content":"relative parent"}),
        ),
        case(
            "write_file",
            json!({"path":"link/linked.txt","content":"symlink parent"}),
        ),
        case(
            "write_file",
            json!({"path":installation.join("resources/ordinary.txt"),"content":"OS accessible installation"}),
        ),
        case(
            "grep_files",
            json!({"root":home.join("Documents"),"pattern":"문서","literal":true}),
        ),
    ]
}

pub(super) async fn approve(
    s: &butler_e2e::e2e::scenario::Scenario,
    id: &str,
    case: &Case,
    script: &provider::Script,
) -> Result<(), HarnessError> {
    let turn =
        s.gw.wait_turn(
            "general",
            id,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(15),
        )
        .await?;
    assert_eq!(
        turn_state(&turn),
        "waiting_for_form",
        "Exact file operation must request approval"
    );
    assert!(
        script.result.lock().unwrap().is_none(),
        "No file result before approval"
    );
    if case.tool == "write_file" {
        let path = s.sandbox.data.join(case.args["path"].as_str().unwrap());
        assert!(!path.exists(), "No write before approval");
    }
    let cards = s.gw.approval_requests("general").await?;
    let card = cards
        .iter()
        .find(|c| c["source_turn_id"] == id)
        .expect("parent conversation card");
    if case.tool != "run_command" {
        assert_eq!(card["executable"], case.tool);
    }
    let paths = if case.tool == "run_command" {
        json!([case.args["command"]])
    } else if case.tool == "read_file" {
        json!(
            case.args["requests"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["path"].clone())
                .collect::<Vec<_>>()
        )
    } else if matches!(case.tool, "list_files" | "grep_files") {
        json!([case.args["root"]])
    } else {
        json!([case.args["path"].as_str().unwrap().replace('\\', "/")])
    };
    assert_eq!(
        card["approval"]["examples"], paths,
        "Exact operation path is visible"
    );
    let reply =
        s.gw.post(
            &format!(
                "/authority-requests/{}/allow?session_id=general",
                card["request_ref"].as_str().unwrap()
            ),
            json!({"scope":if case.tool == "write_file" { "conversation" } else { "once" }}),
        )
        .await?;
    assert_eq!(reply.status, 202);
    Ok(())
}

fn verify(
    home: &Path,
    installation: &Path,
    index: usize,
    output: &Value,
) -> Result<(), HarnessError> {
    assert!(
        output["ok"] == true || output["exit_code"] == 0,
        "File operation refused: error={}, guard={}",
        output["error"],
        output["guard"]
    );
    match index {
        0 => {
            let files = output["files"].as_array().unwrap();
            assert_eq!(files.len(), 2);
            assert_eq!(output["truncated"], false);
            assert_eq!(output["files_considered"], 2);
            assert!(
                files
                    .iter()
                    .all(|f| Path::new(f["path"].as_str().unwrap()).is_absolute())
            );
        }
        1 => {
            assert_eq!(output["files_read"], 1);
            assert_eq!(output["files"][0]["content"], "문서 내용");
        }
        2 => assert_eq!(
            std::fs::read_to_string(home.join("Desktop/새 파일.txt"))?,
            "처음 내용\n"
        ),
        3 => assert_eq!(
            std::fs::read_to_string(home.join("Desktop/새 파일.txt"))?,
            "수정 내용\n"
        ),
        4 | 5 => {
            assert_eq!(output["truncated"], true);
            assert!(output["next_cursor"].is_string());
        }
        6 => assert_eq!(
            std::fs::read_to_string(home.join(".ssh/fixture.key"))?,
            "OS accessible fixture"
        ),
        7 => assert_eq!(
            std::fs::read_to_string(home.join("Downloads/relative.txt"))?,
            "relative parent"
        ),
        8 => assert_eq!(
            std::fs::read_to_string(home.join("Desktop/linked.txt"))?,
            "symlink parent"
        ),
        9 => assert_eq!(
            std::fs::read_to_string(installation.join("resources/ordinary.txt"))?,
            "OS accessible installation"
        ),
        10 => {
            assert_eq!(output["matches"].as_array().unwrap().len(), 1);
            assert_eq!(output["truncated"], false);
            assert!(Path::new(output["matches"][0]["path"].as_str().unwrap()).is_absolute());
        }
        11 => {
            assert!(!home.join("Downloads/보고서.txt").exists());
            assert_eq!(
                std::fs::read_to_string(home.join("Downloads/moved.txt"))?,
                "download"
            );
            assert_eq!(output["output_presentation"]["truncated"], false);
        }
        _ => panic!("unknown case"),
    }
    Ok(())
}

async fn run(access: Access) -> Result<(), HarnessError> {
    let mut setup = Setup::new("ABSOLUTE-FILE-TOOLS")?;
    setup.sandbox.data = setup.sandbox.home.join(".butler");
    for directory in [
        ".butler",
        "Downloads",
        "Documents",
        "Desktop",
        ".ssh",
        "AppData/Local",
        "AppData/Roaming",
    ] {
        std::fs::create_dir_all(setup.sandbox.home.join(directory))?;
    }
    std::fs::write(setup.sandbox.home.join("Downloads/보고서.txt"), "download")?;
    std::fs::write(setup.sandbox.home.join("Downloads/사진.png"), "image")?;
    std::fs::write(setup.sandbox.home.join("Documents/보고서.txt"), "문서 내용")?;
    let home = setup.sandbox.home.clone();
    let installation = setup.sandbox.install.clone();
    butler_platform::secure_fs::symlink(&home.join("Desktop"), &setup.sandbox.data.join("link"))?;
    let (url, script, server) = provider::start(cases(&home, &installation)[0].clone()).await?;
    let s = setup
        .stub_cassette(super::observation_stub::cassette()?)
        .access(access)
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("USERPROFILE", home.display().to_string())
        .env(
            "LOCALAPPDATA",
            home.join("AppData/Local").display().to_string(),
        )
        .env(
            "APPDATA",
            home.join("AppData/Roaming").display().to_string(),
        )
        .env("BUTLER_SECRET_STORE", "file")
        .env("BUTLER_PLATFORM_SYSTEM_SECRETS", "0")
        .env("BUTLER_APP_DISABLE_SHELL_REGISTRATION", "1")
        .start()
        .await?;
    let mut items = cases(&home, &installation);
    if !butler_platform::command_sandbox::POSIX_SHELL {
        items.push(Case { tool:"run_command", refused:false, args:json!({
            "command":format!("powershell.exe -NoProfile -NonInteractive -Command \"Move-Item -LiteralPath '{}' -Destination '{}'\"",
                home.join("Downloads/보고서.txt").display(),home.join("Downloads/moved.txt").display()),
            "state_effect":"mutation","summary":"파일 이동","output_mode":"full"}) });
    }
    for (index, case) in items.iter().enumerate() {
        script.select(case.clone());
        let accepted = s.gw.say("general", provider::PROMPT).await?;
        let id = accepted_turn_id(&accepted)?;
        if access == Access::AskFirst {
            approve(&s, &id, case, &script).await?;
        }
        let turn =
            s.gw.wait_terminal("general", &id, Duration::from_secs(15))
                .await?;
        assert_eq!(turn_state(&turn), "delivered");
        let (output, elapsed) = script
            .result
            .lock()
            .unwrap()
            .clone()
            .expect("model receives tool result");
        verify(&home, &installation, index, &output)?;
        butler_e2e::assert_wall_clock_budget!(elapsed, Duration::from_secs(5), case.tool);
        eprintln!(
            "ABSOLUTE-FILES {access:?} {} {:.1}ms",
            case.tool,
            elapsed.as_secs_f64() * 1000.
        );
        if let Some(cursor) = output["next_cursor"].as_str() {
            let mut continued = case.clone();
            continued.args["cursor"] = json!(cursor);
            script.select(continued.clone());
            let accepted = s.gw.say("general", provider::PROMPT).await?;
            let id = accepted_turn_id(&accepted)?;
            if access == Access::AskFirst {
                approve(&s, &id, &continued, &script).await?;
            }
            s.gw.wait_terminal("general", &id, Duration::from_secs(15))
                .await?;
            let (next, elapsed) = script.result.lock().unwrap().clone().unwrap();
            assert_eq!(next["ok"], true);
            assert_ne!(next["error"], "invalid_cursor");
            if index == 5 {
                assert_ne!(next["files"][0]["path"], output["files"][0]["path"]);
            }
            butler_e2e::assert_wall_clock_budget!(
                elapsed,
                Duration::from_secs(5),
                "absolute continuation"
            );
        }
    }
    if access == Access::FullAccess {
        assert!(s.gw.approval_requests("general").await?.is_empty());
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn absolute_file_tools_outside_data_workspace_in_both_access_modes()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    for access in [Access::FullAccess, Access::AskFirst] {
        run(access).await?;
    }
    Ok(())
}
