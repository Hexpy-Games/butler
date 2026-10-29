//! Settings folder selection -> project chat -> actual workspace tools (#485).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

#[path = "project_workspace/stub.rs"]
pub(super) mod stub;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Access, Scenario, Setup},
};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};

fn selection(s: &Scenario, path: &Path) -> Result<String, HarnessError> {
    let secret = fs::read_to_string(
        s.sandbox
            .data
            .join("state/app-gateway/project-folder-token-secret"),
    )?;
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(
        &json!({"path":path,"expires_at":4_102_444_800_000_u64}),
    )?);
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.trim().as_bytes()).unwrap();
    mac.update(payload.as_bytes());
    Ok(format!(
        "v1.{payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    ))
}

fn project_path(s: &Scenario, project: &Value) -> String {
    let db = butler_platform::sqlite::open_with_flags(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    db.query_row(
        "SELECT workspace_path FROM projects WHERE id=?1",
        [project["id"].as_str().unwrap()],
        |row| row.get(0),
    )
    .unwrap()
}

fn assert_unset_folder(s: &Scenario) {
    let db = butler_platform::sqlite::open_with_flags(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let count: u64 = db
        .query_row(
            "SELECT COUNT(*) FROM app_settings WHERE key='default-project-workspace-root'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0, "fallback must never become a saved preference");
}

pub(super) async fn bind_project(s: &mut Scenario, folder: &Path) -> Result<String, HarnessError> {
    let token = selection(s, folder)?;
    s.patch_settings(
        json!({"default_project_folder_selection_token":token}),
        "project folder",
    )
    .await?;
    s.restart().await?;
    let created =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"작업 Project"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let project = created.data()["project"]["id"].as_str().unwrap();
    let reply = s.gw.post("/sessions", json!({"kind":"project","project_id":project,"workspace_mode":"local","title":"Workspace"})).await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["session"]["id"].as_str().unwrap().to_owned())
}

async fn result(s: &Scenario, chat: &str, prompt: &str) -> Result<Value, HarnessError> {
    let before = s.provider()?.requests().len();
    let id = s.gw.say_turn(chat, prompt).await?;
    let deadline = Instant::now() + Duration::from_secs(60);
    let request = loop {
        let requests = s.gw.approval_requests(chat).await?;
        if let Some(request) = requests.iter().find(|r| r["source_turn_id"] == id) {
            break request.clone();
        }
        assert!(
            Instant::now() < deadline,
            "no observation approval: {requests:?}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(request["category"], "reviewed_effect", "{request}");
    assert_eq!(request["approval"]["operation"]["access"], "read_only");
    assert_eq!(
        s.provider()?.requests().len(),
        before + 1,
        "observation waits for approval"
    );
    let reference = request["request_ref"].as_str().unwrap();
    let allowed =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id={chat}"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(allowed.status, 202, "{allowed:?}");
    let turn =
        s.gw.wait_terminal(chat, &id, Duration::from_secs(60))
            .await?;
    assert_eq!(
        turn_state(&turn),
        "delivered",
        "{turn}; replay misses: {:?}",
        s.provider()?.misses()
    );
    let rows = butler_e2e::e2e::gateway::tool_rows(&s.gw.messages(chat).await?, &id);
    assert_eq!(rows.len(), 1, "{rows:?}");
    // Rejections have no output artifact; check the model's actual tool feedback.
    let requests = s.provider()?.requests();
    let feedback = requests[before..]
        .iter()
        .filter_map(|request| request["input"].as_array())
        .flatten()
        .rfind(|item| item["type"] == "function_call_output")
        .expect("model receives tool feedback")["output"]
        .as_str()
        .expect("tool result JSON");
    let output: Value = serde_json::from_str(feedback)?;
    Ok(output
        .get("output")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or(output))
}

async fn approve_write(
    s: &Scenario,
    chat: &str,
    prompt: &str,
    file: &Path,
    expected: &str,
) -> Result<(), HarnessError> {
    let id = s.gw.say_turn(chat, prompt).await?;
    let deadline = Instant::now() + Duration::from_secs(60);
    let request = loop {
        let page = s.gw.approval_requests(chat).await?;
        if let Some(request) = page.iter().find(|r| r["source_turn_id"] == id) {
            break request.clone();
        }
        assert!(Instant::now() < deadline, "no write approval: {page:?}");
        if let Some(turn) = s.gw.turn(chat, &id).await? {
            assert!(
                !butler_e2e::e2e::gateway::TERMINAL.contains(&turn_state(&turn)),
                "{turn}; model feedback: {:?}",
                s.provider()?.requests().last().map(|r| &r["input"])
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert!(!file.exists(), "wrote before approval");
    let requested = if prompt == stub::WRITE {
        butler_platform::secure_fs::workspace_test_alias(file)
    } else {
        file.to_path_buf()
    };
    assert!(
        request
            .to_string()
            .contains(requested.file_name().unwrap().to_str().unwrap()),
        "{request}"
    );
    let reference = request["request_ref"].as_str().unwrap();
    let reply =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id={chat}"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    let turn =
        s.gw.wait_terminal(chat, &id, Duration::from_secs(60))
            .await?;
    assert_eq!(
        turn_state(&turn),
        "delivered",
        "{turn}; misses: {:?}",
        s.provider()?.misses()
    );
    assert!(
        file.exists(),
        "approved file missing; tool feedback: {:?}",
        s.provider()?
            .requests()
            .iter()
            .filter_map(|r| r["input"].as_array())
            .flatten()
            .filter(|i| i["type"] == "function_call_output")
            .collect::<Vec<_>>()
    );
    let bytes = fs::read(file)?;
    let content = if let Some(utf16) = bytes.strip_prefix(&[0xff, 0xfe]) {
        assert_eq!(utf16.len() % 2, 0, "incomplete UTF-16 marker");
        let units = utf16
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect::<Vec<_>>();
        String::from_utf16(&units).unwrap()
    } else {
        String::from_utf8(bytes).unwrap()
    };
    assert_eq!(content.trim_end(), expected);
    Ok(())
}

async fn workspace_case(long: bool) -> Result<(), HarnessError> {
    let setup = Setup::new(if long {
        "PROJECT-WORKSPACE-LONG"
    } else {
        "PROJECT-WORKSPACE"
    })?
    .access(Access::AskAlways);
    let mut folder = setup.sandbox.workspace.join("선택 Project");
    if long {
        for _ in 0..5 {
            folder = folder.join("long-project-component-012345678901234567890123456789");
        }
    }
    fs::create_dir_all(&folder)?;
    let workspace = folder.join("작업 Project");
    let read_path = butler_platform::secure_fs::workspace_test_alias(&workspace.join("read.txt"));
    let cassette = stub::cassette(&workspace, &read_path, &setup.sandbox.data)?;
    let mut s = setup.stub_cassette(cassette).start().await?;
    let chat = bind_project(&mut s, &folder).await?;
    fs::write(workspace.join("read.txt"), "project marker")?;
    let started = Instant::now();
    let list = result(&s, &chat, stub::LIST).await?;
    assert_eq!(list["ok"], true, "{list}");
    assert_eq!(list["files"].as_array().unwrap().len(), 1, "{list}");
    let read = result(&s, &chat, stub::READ).await?;
    assert_eq!(read["files"][0]["content"], "project marker", "{read}");
    approve_write(
        &s,
        &chat,
        stub::COMMAND,
        &workspace.join("command.txt"),
        "project-command",
    )
    .await?;
    approve_write(
        &s,
        &chat,
        stub::WRITE,
        &workspace.join("written.txt"),
        "approved project write",
    )
    .await?;
    // The data directory follows ordinary exact-operation approval too.
    let data = result(&s, &chat, stub::DATA).await?;
    assert_eq!(data["files"][0]["ok"], true, "{data}");
    assert_eq!(data["files_read"], 1, "{data}");
    assert_eq!(
        data["files"][0]["content"],
        fs::read_to_string(s.sandbox.data.join("butler.config.json"))?
    );
    let root = butler_platform::secure_fs::canonicalize(&workspace)?;
    let scope = serde_json::to_string(&format!("- workspace: {}", root.display()))?;
    for request in s.provider()?.requests() {
        let text = request.to_string();
        assert!(
            text.contains(&scope[1..scope.len() - 1]),
            "workspace missing in prompt"
        );
        assert!(!text.contains("only ~/.butler"));
    }
    assert!(!serde_json::to_string(&s.gw.messages(&chat).await?)?.contains("only ~/.butler"));
    eprintln!(
        "project workspace long={long}: {} ms",
        started.elapsed().as_millis()
    );
    s.finish().await
}

#[tokio::test]
async fn settings_project_workspace_tools_and_approval() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    workspace_case(false).await
}

#[tokio::test]
async fn settings_long_project_workspace_tools_and_approval() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    workspace_case(true).await
}

#[tokio::test]
async fn normal_chat_default_project_folder_refreshes_next_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("DEFAULT-PROJECT-FOLDER")?
        .access(Access::AskAlways)
        .stub_cassette(butler_e2e::e2e::cassette::Cassette::load("TOOL-01")?);
    let default_folder = setup.sandbox.home.join("butler-workspace");
    let (url, server, requests) = stub::default_folder_model().await?;
    let setup = setup.env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let folders = [
        setup.sandbox.workspace.join("first"),
        setup.sandbox.workspace.join("second"),
    ];
    for folder in &folders {
        fs::create_dir_all(folder)?;
        fs::write(folder.join("a.txt"), "project marker")?;
    }
    let mut s = setup.start().await?;
    assert!(
        !default_folder.exists(),
        "startup must not create the default folder"
    );
    let settings = s.gw.get("/settings").await?;
    assert_eq!(
        settings.data()["default_project_workspace_label"],
        "butler-workspace"
    );
    let (_, unset) = s.turn("general", "Check the unset default folder.").await?;
    assert_eq!(turn_state(&unset), "delivered", "{unset}");
    stub::assert_default_folder(&requests, &default_folder, 1);
    assert!(
        !default_folder.exists(),
        "prompt and Settings reads must not create it"
    );
    let legacy = s.sandbox.data.join("workspaces/projects/Existing");
    fs::create_dir_all(&legacy)?;
    fs::write(legacy.join("marker.txt"), "existing marker")?;
    let imported =
        s.gw.post(
            "/projects",
            json!({"source":"existing_folder",
        "folder_selection_token":selection(&s, &legacy)?}),
        )
        .await?;
    assert_eq!(imported.status, 201, "{}", imported.text);
    let existing = imported.data()["project"].clone();
    let existing_path = project_path(&s, &existing);
    assert!(
        !default_folder.exists(),
        "import must not create the default folder"
    );
    let created =
        s.gw.post(
            "/projects",
            json!({"source":"scratch",
        "display_name":"Default"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    assert_eq!(
        project_path(&s, &created.data()["project"]),
        default_folder.join("Default").to_string_lossy().as_ref()
    );
    assert!(default_folder.join("Default").is_dir());
    let session =
        s.gw.post(
            "/sessions",
            json!({"kind":"project",
        "project_id":created.data()["project"]["id"], "workspace_mode":"local"}),
        )
        .await?;
    assert_eq!(session.status, 201, "{}", session.text);
    let chat = session.data()["session"]["id"].as_str().unwrap().to_owned();
    let (_, first) = s.turn(&chat, "Check the unset default folder.").await?;
    assert_eq!(turn_state(&first), "delivered", "{first}");
    stub::assert_default_folder(&requests, &default_folder, 2);
    assert_unset_folder(&s);
    s.restart().await?;
    assert_unset_folder(&s);
    let started = Instant::now();
    for (index, folder) in folders.iter().enumerate() {
        s.patch_settings(
            json!({"default_project_folder_selection_token":selection(&s, folder)?}),
            "default folder",
        )
        .await?;
        s.restart().await?;
        let settings = s.gw.get("/settings").await?;
        assert_eq!(
            settings.data()["default_project_workspace_label"],
            folder.file_name().unwrap().to_str().unwrap()
        );
        let id =
            s.gw.say_turn(
                "general",
                &format!("List my default project folder {index}."),
            )
            .await?;
        let turn =
            s.gw.wait_turn(
                "general",
                &id,
                &["waiting_for_form", "delivered", "failed"],
                Duration::from_secs(60),
            )
            .await?;
        assert_eq!(turn_state(&turn), "waiting_for_form", "{turn}");
        let requests = s.gw.approval_requests("general").await?;
        let request = requests.iter().find(|r| r["source_turn_id"] == id).unwrap();
        let expected = serde_json::to_string(&butler_platform::secure_fs::canonicalize(folder)?)?;
        assert!(
            request
                .to_string()
                .contains(&expected[1..expected.len() - 1]),
            "{request}"
        );
        assert_eq!(request["approval"]["operation"]["access"], "read_only");
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
        let rows = butler_e2e::e2e::gateway::tool_rows(&s.gw.messages("general").await?, &id);
        assert_eq!(rows.len(), 1, "{rows:?}");
        let output: Value = serde_json::from_str(&s.gw.operation_output(&id, &rows[0]).await?)?;
        assert_eq!(output["ok"], true, "{output}");
        assert_eq!(output["files"].as_array().unwrap().len(), 1, "{output}");
        assert!(output["files"][0].to_string().contains("a.txt"), "{output}");
        let created =
            s.gw.post(
                "/projects",
                json!({"source":"scratch",
            "display_name":"Configured"}),
            )
            .await?;
        assert_eq!(created.status, 201, "{}", created.text);
        assert_eq!(
            project_path(&s, &created.data()["project"]),
            folder.join("Configured").to_string_lossy().as_ref()
        );
        let listed = s.gw.get("/projects").await?;
        let listed_data = listed.data();
        let retained = listed_data["projects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|project| project["id"] == existing["id"])
            .unwrap();
        assert_eq!(project_path(&s, retained), existing_path);
        assert_eq!(
            fs::read_to_string(legacy.join("marker.txt"))?,
            "existing marker"
        );
    }
    eprintln!(
        "default project folder: two approved turns in {} ms",
        started.elapsed().as_millis()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
