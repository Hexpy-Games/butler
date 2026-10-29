//! CLI selection changes the canonical App preference and the next real tool turn.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    gateway::{tool_rows, turn_state},
    scenario::{Access, Setup},
};
use serde_json::{Value, json};
use std::{fs, time::Duration};

#[tokio::test]
async fn cli_project_folder_next_turn_and_validation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("CLI-PROJECT-FOLDER")?
        .access(Access::AskAlways)
        .stub_cassette(butler_e2e::e2e::cassette::Cassette::load("TOOL-01")?);
    let (url, server, _) = super::project_workspace::stub::default_folder_model().await?;
    let setup = setup.env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let first = setup.sandbox.workspace.join("first");
    let second = setup.sandbox.workspace.join("second");
    fs::create_dir_all(&first)?;
    fs::create_dir_all(&second)?;
    fs::write(first.join("first.txt"), "first")?;
    fs::write(second.join("second.txt"), "second")?;
    let launch = butler_e2e::e2e::agent::Launch::new(&setup.sandbox)?;
    let shown = launch
        .command()
        .args(["folder", "show", "--json"])
        .output()?;
    assert!(shown.status.success(), "{shown:?}");
    let shown: Value = serde_json::from_slice(&shown.stdout)?;
    assert_eq!(
        shown["data"]["path"],
        setup
            .sandbox
            .home
            .join("butler-workspace")
            .to_string_lossy()
            .as_ref()
    );
    assert!(
        !setup
            .sandbox
            .data
            .join("app-server/butler-client.sqlite")
            .exists()
    );
    let set = launch
        .command()
        .args(["folder", "set"])
        .arg(&first)
        .arg("--json")
        .output()?;
    assert!(set.status.success(), "{set:?}");
    let mut s = setup.start().await?;
    let shown = s.agent.cli_async(&["folder", "show", "--json"]).await?;
    assert_eq!(shown.code, Some(0), "{shown:?}");
    let shown: Value = serde_json::from_str(&shown.stdout)?;
    assert_eq!(
        shown["data"]["path"],
        butler_platform::secure_fs::canonicalize(&first)?
            .to_string_lossy()
            .as_ref()
    );
    for folder in [&first, &second] {
        let set = s
            .agent
            .cli_async(&["folder", "set", folder.to_str().unwrap(), "--json"])
            .await?;
        assert_eq!(set.code, Some(0), "{set:?}");
        let shown = s.agent.cli_async(&["folder", "show", "--json"]).await?;
        let shown: Value = serde_json::from_str(&shown.stdout)?;
        assert_eq!(
            shown["data"]["path"],
            butler_platform::secure_fs::canonicalize(folder)?
                .to_string_lossy()
                .as_ref()
        );
        let id =
            s.gw.say_turn("general", "List my default project folder.")
                .await?;
        let waiting =
            s.gw.wait_turn(
                "general",
                &id,
                &["waiting_for_form", "delivered", "failed"],
                Duration::from_secs(60),
            )
            .await?;
        assert_eq!(turn_state(&waiting), "waiting_for_form", "{waiting}");
        let requests = s.gw.approval_requests("general").await?;
        let request = requests
            .iter()
            .find(|request| request["source_turn_id"] == id)
            .unwrap();
        let reference = request["request_ref"].as_str().unwrap();
        let allowed =
            s.gw.post(
                &format!("/authority-requests/{reference}/allow?session_id=general"),
                json!({"scope":"once"}),
            )
            .await?;
        assert_eq!(allowed.status, 202, "{allowed:?}");
        let turn =
            s.gw.wait_terminal("general", &id, Duration::from_secs(60))
                .await?;
        assert_eq!(turn_state(&turn), "delivered", "{turn}");
        let rows = tool_rows(&s.gw.messages("general").await?, &id);
        assert_eq!(rows.len(), 1, "{rows:?}");
        let output: Value = serde_json::from_str(&s.gw.operation_output(&id, &rows[0]).await?)?;
        assert_eq!(output["ok"], true, "{output}");
        assert_eq!(output["files"].as_array().unwrap().len(), 1, "{output}");
        assert!(
            output["files"][0]
                .to_string()
                .contains(if folder == &first {
                    "first.txt"
                } else {
                    "second.txt"
                }),
            "{output}"
        );
    }
    let missing = s.sandbox.workspace.join("missing");
    let file = second.join("second.txt");
    let inside = s.sandbox.data.join("forbidden");
    fs::create_dir_all(&inside)?;
    for path in [&missing, &file, &inside, &s.sandbox.data] {
        let rejected = s
            .agent
            .cli_async(&["folder", "set", path.to_str().unwrap(), "--json"])
            .await?;
        assert_ne!(rejected.code, Some(0), "{rejected:?}");
        let rejected: Value = serde_json::from_str(&rejected.stdout)?;
        assert_eq!(rejected["ok"], false);
    }
    s.restart().await?;
    let shown = s.agent.cli_async(&["folder", "show", "--json"]).await?;
    let shown: Value = serde_json::from_str(&shown.stdout)?;
    assert_eq!(
        shown["data"]["path"],
        butler_platform::secure_fs::canonicalize(&second)?
            .to_string_lossy()
            .as_ref()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
