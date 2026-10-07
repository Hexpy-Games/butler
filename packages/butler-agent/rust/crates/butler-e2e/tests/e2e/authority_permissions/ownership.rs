//! Batch metadata keeps explicit ownership precedence and fresh rotation/project state.
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::{Value, json};

#[tokio::test]
async fn approvals_resolve_current_runtime_owners() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("APPROVALS-OWNERS")?.start().await?;
    super::seed::seed(s.sandbox.data.clone(), 5, false).await?;
    let before = s.gw.get("/authority-permissions").await?;
    assert_eq!(before.status, 200);
    let db = butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    db.execute_batch(
        "INSERT INTO projects(id,display_name,status,workspace_path,workspace_label,safe_path_label,created_at,updated_at)
           VALUES('project','Current project','active','/workspace','Workspace','Workspace','2000','2000');
         UPDATE chats SET runtime_session_hint='rotated-0' WHERE id='chat-0';
         UPDATE chats SET runtime_session_hint='butler/app-chat-0',project_id='project' WHERE id='chat-1';
         UPDATE chats SET runtime_session_hint='rotated-2' WHERE id='chat-2';",
    )?;
    let mut expected = before.data()["permissions"].clone();
    set_metadata(
        &mut expected,
        "butler/app-chat-0",
        Some("Chat 1"),
        Some("project"),
        Some("Current project"),
    );
    for owner in ["butler/app-chat-1", "butler/app-chat-2"] {
        set_metadata(&mut expected, owner, None, None, None);
    }
    let current = s.gw.get("/authority-permissions").await?;
    assert_eq!(current.status, 200);
    assert_eq!(current.data()["permissions"], expected);
    db.execute_batch(
        "UPDATE projects SET display_name='/message-files/file-0b7c3a51-2d4e-4f7a-9c1b-6e8d5f2a3b4c' WHERE id='project';
         UPDATE chats SET title='Latest owner' WHERE id='chat-1';",
    )?;
    set_metadata(
        &mut expected,
        "butler/app-chat-0",
        Some("Latest owner"),
        Some("project"),
        Some("/message-files/file-0b7c3a51-2d4e-4f7a-9c1b-6e8d5f2a3b4c"),
    );
    let latest = s.gw.get("/authority-permissions").await?;
    assert_eq!(latest.status, 200);
    assert_eq!(latest.data()["permissions"], expected);
    db.execute(
        "UPDATE chats SET runtime_session_hint=NULL WHERE id='chat-1'",
        [],
    )?;
    set_metadata(&mut expected, "butler/app-chat-0", None, None, None);
    set_metadata(
        &mut expected,
        "butler/app-chat-1",
        Some("Latest owner"),
        Some("project"),
        Some("/message-files/file-0b7c3a51-2d4e-4f7a-9c1b-6e8d5f2a3b4c"),
    );
    let unrotated = s.gw.get("/authority-permissions").await?;
    assert_eq!(unrotated.status, 200);
    assert_eq!(unrotated.data()["permissions"], expected);
    drop(db);
    s.finish().await
}

fn set_metadata(
    grants: &mut Value,
    owner: &str,
    title: Option<&str>,
    project: Option<&str>,
    name: Option<&str>,
) {
    for grant in grants.as_array_mut().unwrap() {
        if grant["session_id"] == owner {
            grant["session_title"] = json!(title);
            grant["project_id"] = json!(project);
            grant["project_name"] = json!(name);
        }
    }
}
