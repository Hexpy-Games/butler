//! Basic Windows capabilities in a profile with sibling Downloads and .butler.
#[path = "capabilities/approval_resume.rs"]
mod approval_resume;
#[path = "capabilities/current_work.rs"]
mod current_work;
#[path = "capabilities/delegation.rs"]
mod delegation;
use super::capability_stub::{self as provider, Case};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Access, Scenario, Setup, accepted_turn_id},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    time::{Duration, Instant},
};

const SECRET: &str = "isolated-e2e-folder-selection-secret";

fn selection(path: &Path) -> String {
    let payload =
        URL_SAFE_NO_PAD.encode(json!({"path":path,"expires_at":4_102_444_800_000_u64}).to_string());
    let mut inner = [0x36; 64];
    let mut outer = [0x5c; 64];
    for (i, byte) in SECRET.bytes().enumerate() {
        inner[i] ^= byte;
        outer[i] ^= byte;
    }
    let digest = Sha256::digest([inner.as_slice(), payload.as_bytes()].concat());
    let signature = URL_SAFE_NO_PAD.encode(Sha256::digest(
        [outer.as_slice(), digest.as_slice()].concat(),
    ));
    format!("v1.{payload}.{signature}")
}

async fn chat(s: &Scenario) -> Result<String, HarnessError> {
    let project =
        s.gw.post(
            "/projects",
            json!({"source":"existing_folder",
        "folder_selection_token":selection(&s.sandbox.root),"display_name":"Profile capability"}),
        )
        .await?;
    assert_eq!(project.status, 201, "{}", project.text);
    let session =
        s.gw.post(
            "/sessions",
            json!({"kind":"project",
        "project_id":project.data()["project"]["id"],"title":"Windows basics"}),
        )
        .await?;
    assert_eq!(session.status, 201, "{}", session.text);
    Ok(session.data()["session"]["id"].as_str().unwrap().to_owned())
}

fn cases(data: &Path) -> Vec<Case> {
    let case = |tool, mut args: Value| {
        if tool == "run_command" {
            args["cwd"] = json!("home/Downloads");
        }
        Case {
            tool,
            args,
            refused: false,
        }
    };
    let ordinary_data = "home/.butler";
    vec![
        case(
            "list_files",
            json!({"root":"home/Downloads","max_depth":1,"max_results":100}),
        ),
        case(
            "read_file",
            json!({"requests":[{"path":"home/Downloads/보고서.txt"}]}),
        ),
        case(
            "write_file",
            json!({"path":"home/Downloads/새 파일.txt","content":"처음 내용\n","overwrite":false}),
        ),
        case(
            "edit_file",
            json!({"path":"home/Downloads/새 파일.txt","old_text":"처음 내용","new_text":"수정 내용"}),
        ),
        case(
            "run_command",
            json!({"command":"powershell.exe -NoProfile -NonInteractive -Command \"Rename-Item -LiteralPath '새 파일.txt' -NewName '이름 변경.txt'\"",
            "state_effect":"mutation","summary":"이름 변경","output_mode":"full"}),
        ),
        case(
            "run_command",
            json!({"command":"powershell.exe -NoProfile -NonInteractive -Command \"Move-Item -LiteralPath '이름 변경.txt' -Destination '정리/이름 변경.txt'\"",
            "state_effect":"mutation","summary":"파일 이동","output_mode":"full"}),
        ),
        case(
            "run_command",
            json!({"command":"powershell.exe -NoProfile -Command \"Write-Output '한국어 출력'\"",
            "state_effect":"read_only","summary":"출력 확인","output_mode":"full"}),
        ),
        case(
            "run_command",
            json!({"command":"cmd.exe /d /c \"echo 한국어 출력\"",
            "state_effect":"read_only","summary":"출력 확인","output_mode":"full"}),
        ),
        Case {
            tool: "list_files",
            args: json!({"root":ordinary_data,"max_depth":1,"max_results":100,
                "exclude_globs":["home/.butler/*/*"]}),
            refused: false,
        },
        Case {
            tool: "read_file",
            args: json!({"requests":[{"path":"home/.butler/canary.txt"}]}),
            refused: false,
        },
        Case {
            tool: "write_file",
            args: json!({"path":"home/.butler/approved.txt","content":"approved"}),
            refused: false,
        },
        Case {
            tool: "run_command",
            args: json!({"command":format!("Get-Content -LiteralPath '{}'",data.join("canary.txt").display()),
            "state_effect":"read_only","summary":"보호 경로 확인"}),
            refused: false,
        },
        Case {
            tool: "run_command",
            args: json!({"command":"Get-Content -LiteralPath '.ssh/id_ed25519'",
                "state_effect":"read_only","summary":"자격 증명 경로 확인"}),
            refused: true,
        },
        Case {
            tool: "write_file",
            args: json!({"path":"home/.butler/../escape.txt","content":"ordinary parent"}),
            refused: false,
        },
        case(
            "write_file",
            json!({"path":"home/.butler/project-ledger/projects/e2e/approved.txt","content":"ordinary data"}),
        ),
        case(
            "run_command",
            json!({"command":"Get-Content -LiteralPath (Join-Path $env:BUTLER_DATA 'canary.txt')",
            "state_effect":"read_only","summary":"데이터 경로 확인","output_mode":"full"}),
        ),
    ]
}

async fn operation(
    s: &Scenario,
    chat: &str,
    script: &provider::Script,
    case: &Case,
    access: Access,
) -> Result<(Value, Duration), HarnessError> {
    eprintln!(
        "Starting Windows capability: access={access:?} tool={} refused={} args={}",
        case.tool, case.refused, case.args
    );
    script.select(case.clone());
    let accepted = s.gw.say(chat, provider::PROMPT).await?;
    let id = accepted_turn_id(&accepted)?;
    let turn =
        s.gw.wait_turn(
            chat,
            &id,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(15),
        )
        .await;
    if let Err(error) = &turn {
        eprintln!(
            "Windows capability wait failed: {error}; complete tool result={:?}",
            script.result.lock().unwrap()
        );
        eprintln!(
            "Windows capability disposition={:?}",
            script.disposition.lock().unwrap()
        );
    }
    let turn = turn?;
    assert_eq!(turn["execution_controls"]["access_mode"], access.as_str());
    if turn_state(&turn) == "waiting_for_form" {
        // Stored ask_first is Ask every time: command admission precedes the
        // executor's credential refusal. Allow must never bypass that refusal.
        assert_eq!(access, Access::AskAlways);
        assert!(script.result.lock().unwrap().is_none(), "ran before Allow");
        let cards = s.gw.approval_requests(chat).await?;
        let card = cards
            .iter()
            .find(|c| c["source_turn_id"] == id)
            .expect("visible exact approval card");
        assert_eq!(
            card["approval"]["action_kind"],
            if case.tool == "run_command" {
                "run_command"
            } else if matches!(case.tool, "read_file" | "list_files" | "grep_files") {
                "other"
            } else {
                "edit_files"
            }
        );
        let examples = if case.tool == "run_command" {
            json!([case.args["command"]])
        } else if case.tool == "list_files" {
            json!([s.sandbox.root.join(case.args["root"].as_str().unwrap())])
        } else if case.tool == "read_file" {
            json!([s
                .sandbox
                .root
                .join(case.args["requests"][0]["path"].as_str().unwrap())])
        } else {
            json!([if case.args["path"] == "home/.butler/../escape.txt" {
                "home/escape.txt"
            } else {
                case.args["path"].as_str().unwrap()
            }])
        };
        assert_eq!(card["approval"]["examples"], examples);
        let operation = &card["approval"]["operation"];
        assert_eq!(operation["tool"], case.tool);
        assert_eq!(
            operation["access"],
            if matches!(case.tool, "read_file" | "list_files" | "grep_files")
                || matches!(
                    case.args["state_effect"].as_str(),
                    Some("read_only" | "validation")
                )
            {
                "read_only"
            } else {
                "change"
            }
        );
        if case.tool == "list_files" {
            assert_eq!(operation["targets"], examples);
        } else if case.tool == "run_command" {
            assert_eq!(operation["command"], case.args["command"]);
            let cwd = case.args["cwd"].as_str().filter(|path| *path != ".");
            assert_eq!(
                operation["targets"],
                json!([
                    cwd.map_or_else(|| s.sandbox.root.clone(), |path| s.sandbox.root.join(path))
                ])
            );
        }
        if case.tool == "write_file" {
            assert!(
                !s.sandbox
                    .root
                    .join(case.args["path"].as_str().unwrap())
                    .exists()
            );
        }
        let reply =
            s.gw.post(
                &format!(
                    "/authority-requests/{}/allow?session_id={chat}",
                    card["request_ref"].as_str().unwrap()
                ),
                json!({"scope":"once"}),
            )
            .await?;
        assert_eq!(reply.status, 202, "{}", reply.text);
        assert_eq!(reply.data()["decision"], "allowed");
    } else if access == Access::AskAlways {
        panic!(
            "Mutation/command must show an approval card: {turn}; result={:?}",
            script.result.lock().unwrap()
        );
    }
    let terminal = s.gw.wait_terminal(chat, &id, Duration::from_secs(15)).await;
    if terminal.is_err() {
        super::log_approval_timeout_diagnostics(s, chat, &id).await?;
    }
    let turn = terminal?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let (output, elapsed) = script
        .result
        .lock()
        .unwrap()
        .clone()
        .expect("model receives complete result");
    let budget = Duration::from_secs(if case.refused { 1 } else { 5 });
    butler_e2e::assert_wall_clock_budget!(elapsed, budget, case.tool);
    if case.refused {
        let expected = if case.tool == "write_file" {
            "parent_traversal_not_allowed"
        } else {
            "protected_path"
        };
        assert!(output.to_string().contains(expected), "{output}");
        assert!(!output.to_string().contains("PRIVATE_CANARY"));
    } else {
        assert!(output["ok"] == true || output["exit_code"] == 0, "{output}");
    }
    eprintln!(
        "WINDOWS-BASIC {access:?} {} refused={} {:.1}ms",
        case.tool,
        case.refused,
        elapsed.as_secs_f64() * 1000.
    );
    Ok((output, elapsed))
}

fn verify(s: &Scenario, index: usize, output: &Value) -> Result<(), HarnessError> {
    let downloads = s.sandbox.home.join("Downloads");
    match index {
        0 => {
            assert_eq!(output["truncated"], false);
            assert_eq!(
                output["files"],
                json!([{"path":"home/Downloads/보고서.txt","bytes":13}])
            );
        }
        1 => {
            assert_eq!(output["files"][0]["content"], "기존 내용");
            assert_eq!(output["files_read"], 1);
            assert_eq!(output["truncated"], false);
        }
        2 => assert_eq!(
            std::fs::read_to_string(downloads.join("새 파일.txt"))?,
            "처음 내용\n"
        ),
        3 => assert_eq!(
            std::fs::read_to_string(downloads.join("새 파일.txt"))?,
            "수정 내용\n"
        ),
        4 => {
            assert!(!downloads.join("새 파일.txt").exists());
            assert_eq!(
                std::fs::read_to_string(downloads.join("이름 변경.txt"))?,
                "수정 내용\n"
            );
        }
        5 => {
            assert!(!downloads.join("이름 변경.txt").exists());
            assert_eq!(
                std::fs::read_to_string(downloads.join("정리/이름 변경.txt"))?,
                "수정 내용\n"
            );
        }
        6 | 7 => {
            assert_eq!(output["stdout"].as_str().unwrap().trim(), "한국어 출력");
            assert_eq!(output["output_presentation"]["truncated"], false);
        }
        8 => {
            assert_eq!(output["truncated"], false);
            assert!(
                output["files"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|f| f["path"] == "home/.butler/canary.txt")
            );
        }
        9 => assert_eq!(output["files"][0]["content"], "PRIVATE_CANARY"),
        10 => assert_eq!(
            std::fs::read_to_string(s.sandbox.data.join("approved.txt"))?,
            "approved"
        ),
        12 => assert_eq!(output["error"], "protected_path"),
        13 => assert_eq!(
            std::fs::read_to_string(s.sandbox.home.join("escape.txt"))?,
            "ordinary parent"
        ),
        14 => assert_eq!(
            std::fs::read_to_string(
                s.sandbox
                    .data
                    .join("project-ledger/projects/e2e/approved.txt")
            )?,
            "ordinary data"
        ),
        11 | 15 => assert_eq!(output["stdout"].as_str().unwrap().trim(), "PRIVATE_CANARY"),
        _ => panic!("Unknown capability case {index}"),
    }
    Ok(())
}

async fn setup(
    access: Access,
) -> Result<
    (
        Scenario,
        String,
        std::sync::Arc<provider::Script>,
        tokio::task::JoinHandle<()>,
    ),
    HarnessError,
> {
    let mut setup = Setup::new("WINDOWS-BASIC")?;
    setup.sandbox.data = setup.sandbox.home.join(".butler");
    for folder in [
        ".butler/project-ledger/projects/e2e",
        "Downloads/정리",
        "Documents",
        "Desktop",
        "AppData/Local",
        "AppData/Roaming",
    ] {
        std::fs::create_dir_all(setup.sandbox.home.join(folder))?;
    }
    std::fs::write(setup.sandbox.home.join("Downloads/보고서.txt"), "기존 내용")?;
    std::fs::write(setup.sandbox.data.join("canary.txt"), "PRIVATE_CANARY")?;
    let cases = cases(&setup.sandbox.data);
    let (url, script, server) = provider::start(cases[0].clone()).await?;
    let home = setup.sandbox.home.clone();
    let s = setup
        .stub_cassette(super::observation_stub::cassette()?)
        .access(access)
        .env("BUTLER_CODEX_BASE_URL", url)
        // Match the installed App, not the runner's PowerShell console and
        // its potentially large third-party module discovery path.
        .env("PSModulePath", "")
        .env("BUTLER_DEBUG_COMMAND_TIMINGS", "1")
        .env("USERPROFILE", home.display().to_string())
        .env(
            "LOCALAPPDATA",
            home.join("AppData/Local").display().to_string(),
        )
        .env(
            "APPDATA",
            home.join("AppData/Roaming").display().to_string(),
        )
        .env("BUTLER_PROJECT_FOLDER_TOKEN_SECRET", SECRET)
        .env("BUTLER_SECRET_STORE", "file")
        .env("BUTLER_PLATFORM_SYSTEM_SECRETS", "0")
        .env("BUTLER_APP_DISABLE_SHELL_REGISTRATION", "1")
        .start()
        .await?;
    let chat = chat(&s).await?;
    Ok((s, chat, script, server))
}

async fn run(access: Access) -> Result<(), HarnessError> {
    let (s, chat, script, server) = setup(access).await?;
    let started = Instant::now();
    for (index, case) in cases(&s.sandbox.data).iter().enumerate() {
        let (output, _) = operation(&s, &chat, &script, case, access).await?;
        verify(&s, index, &output)?;
    }
    if access == Access::FullAccess {
        assert!(s.gw.approval_requests(&chat).await?.is_empty());
    }
    eprintln!(
        "WINDOWS-BASIC {access:?}: 16 complete cases in {:?}",
        started.elapsed()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn real_profile_like_basic_capabilities_in_both_access_modes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Windows capability suite"
    );
    for access in [Access::AskAlways, Access::FullAccess] {
        run(access).await?;
    }
    Ok(())
}

#[tokio::test]
async fn delegated_file_approval_is_visible_in_parent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Windows child approval"
    );
    let (s, chat, script, server) = setup(Access::AskAlways).await?;
    delegation::approve(&s, &chat, &script).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}
