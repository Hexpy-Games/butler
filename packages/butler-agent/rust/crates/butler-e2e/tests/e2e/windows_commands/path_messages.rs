//! General-chat path parsing and truthful failure messages through a stub model.
use super::{
    capability_stub::{self as provider, Case},
    observation_stub,
};
use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Access, Setup},
};
use serde_json::json;

#[tokio::test]
async fn general_chat_home_paths_and_rejections() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("GENERAL-PATH-MESSAGES")?;
    let home = setup.sandbox.home.clone();
    std::fs::create_dir_all(home.join("Documents"))?;
    std::fs::create_dir_all(home.join(".ssh"))?;
    std::fs::write(
        home.join(".ssh/authorized_keys"),
        "protected directory marker",
    )?;
    std::fs::write(home.join("Documents/marker.txt"), "outside data marker\n")?;
    let cases = [
        Case {
            tool: "read_file",
            refused: false,
            args: json!({"requests":[
                {"path":home.join("Documents/marker.txt")},
                {"path":"~/Documents/marker.txt"},
                {"path":"~\\Documents/marker.txt"},
                {"path":home.join("Documents/missing.txt")},
                {"path":"~"}
            ]}),
        },
        Case {
            tool: "list_files",
            refused: false,
            args: json!({"root":"~/Documents"}),
        },
        Case {
            tool: "write_file",
            refused: false,
            args: json!({"path":"~/Documents/written.txt","content":"home write"}),
        },
        Case {
            tool: "run_command",
            refused: true,
            args: json!({"command":"echo marker","cwd":"~/missing-directory","state_effect":"mutation","summary":"Check missing directory"}),
        },
        Case {
            tool: "run_command",
            refused: false,
            args: json!({"command":"echo marker > cwd.txt","cwd":"~/Documents","state_effect":"mutation","summary":"Write cwd marker"}),
        },
        Case {
            tool: "run_command",
            refused: true,
            args: json!({"command":"echo marker","cwd":"~/Documents/marker.txt","state_effect":"mutation","summary":"Check file directory"}),
        },
        Case {
            tool: "run_command",
            refused: true,
            args: json!({"command":"echo changed > authorized_keys","cwd":"~/.ssh","state_effect":"mutation","summary":"Check protected directory"}),
        },
    ];
    let (url, script, server) = provider::start(cases[0].clone()).await?;
    let s = setup
        .stub_cassette(observation_stub::cassette()?)
        .access(Access::FullAccess)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    for (index, case) in cases.into_iter().enumerate() {
        script.select(case);
        let (_, turn) = s.turn("general", provider::PROMPT).await?;
        assert_eq!(turn_state(&turn), "delivered", "{turn}");
        let output = script
            .result
            .lock()
            .unwrap()
            .clone()
            .expect("model receives result")
            .0;
        match index {
            0 => {
                let files = output["files"].as_array().unwrap();
                assert_eq!(files.len(), 5);
                assert_eq!(output["files_read"], 3, "{output}");
                for file in &files[..3] {
                    assert_eq!(file["ok"], true, "{file}");
                    assert_eq!(file["content"], "outside data marker\n");
                }
                assert_eq!(files[3]["error"], "not_found");
                assert_eq!(files[4]["error"], "not_a_file");
                for file in &files[3..] {
                    assert!(file.get("workspace_root").is_none(), "{file}");
                    assert!(file["guard"].get("workspace_root").is_none(), "{file}");
                    assert!(!file.to_string().contains("contained"), "{file}");
                    assert!(
                        !file.to_string().contains("inside the session workspace"),
                        "{file}"
                    );
                }
            }
            1 => {
                assert_eq!(output["ok"], true, "{output}");
                assert_eq!(output["files"].as_array().unwrap().len(), 1);
                assert_eq!(output["files"][0]["bytes"], 20);
            }
            2 => assert_eq!(
                std::fs::read_to_string(home.join("Documents/written.txt"))?,
                "home write"
            ),
            3 => {
                assert!(output.to_string().contains("not_found"), "{output}");
                assert!(
                    !output.to_string().contains("inside the session workspace"),
                    "{output}"
                );
            }
            4 => {
                assert_eq!(output["exit_code"], 0, "{output}");
                assert!(home.join("Documents/cwd.txt").is_file());
                assert!(!s.sandbox.data.join("cwd.txt").exists());
            }
            5 => {
                assert!(output.to_string().contains("not_a_directory"), "{output}");
                assert!(
                    !output.to_string().contains("inside the session workspace"),
                    "{output}"
                );
            }
            6 => {
                assert_eq!(output["error"], "protected_path", "{output}");
                assert_eq!(
                    std::fs::read_to_string(home.join(".ssh/authorized_keys"))?,
                    "protected directory marker"
                );
            }
            _ => panic!("Unknown path case {index}"),
        }
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn home_command_directory_keeps_exact_approval() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("HOME-CWD-APPROVAL")?;
    let marker = setup.sandbox.home.join("Documents/approved.txt");
    std::fs::create_dir_all(marker.parent().unwrap())?;
    let case = Case {
        tool: "run_command",
        refused: false,
        args: json!({"command":"echo approved > approved.txt","cwd":"~/Documents",
            "state_effect":"mutation","summary":"Write approved marker"}),
    };
    let (url, script, server) = provider::start(case.clone()).await?;
    let s = setup
        .stub_cassette(observation_stub::cassette()?)
        .access(Access::AskAlways)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    let accepted = s.gw.say("general", provider::PROMPT).await?;
    let id = s.gw.accepted_turn(&accepted).await?;
    assert!(!marker.exists(), "No write before approval");
    super::file_paths::approve(&s, &id, &case, &script).await?;
    let turn =
        s.gw.wait_terminal("general", &id, std::time::Duration::from_secs(15))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let output = script
        .result
        .lock()
        .unwrap()
        .clone()
        .expect("model receives result")
        .0;
    assert_eq!(output["exit_code"], 0, "{output}");
    assert!(marker.is_file());
    assert!(!s.sandbox.data.join("approved.txt").exists());
    s.finish().await?;
    server.abort();
    Ok(())
}
