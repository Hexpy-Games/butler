//! Project removal wakes the projection owner even without transcript/file changes.
use super::*;
use butler_platform::data_paths::MESSAGE_HANDOFFS;
use std::time::Instant;

#[tokio::test]
async fn permanent_project_delete_reclaims_owned_handoff() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("PROJECT-DELETE-HANDOFF")?.start().await?;
    let created =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Files"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{created:?}");
    let project = created.data()["project"]["id"].as_str().unwrap().to_owned();
    let created =
        s.gw.post("/sessions", json!({"kind":"project","project_id":project}))
            .await?;
    assert_eq!(created.status, 201, "{created:?}");
    let chat = created.data()["session"]["id"].as_str().unwrap().to_owned();
    s.agent.terminate().await?;
    let db = app(&s)?;
    for (turn, chat) in [("project-files", chat.as_str()), ("other-files", "general")] {
        db.execute("INSERT INTO turns(id,chat_id,state,safe_status_label,created_at,updated_at) VALUES(?1,?2,'waiting_for_form','Waiting','2026-01-01','2026-01-01')", params![turn,chat])?;
    }
    drop(db);
    let root = s.sandbox.data.join(MESSAGE_HANDOFFS);
    for turn in ["project-files", "other-files", "ownerless-files"] {
        let path = root.join(turn);
        std::fs::create_dir_all(&path)?;
        std::fs::write(path.join(".turn"), json!({"turn":turn}).to_string())?;
        std::fs::write(path.join("copy"), "Complete retained attachment")?;
    }
    s.gw = s.agent.start_again().await?;
    // Startup reclaim proves the inventory has loaded before the removal event.
    wait_removed(&root.join("ownerless-files")).await;
    for turn in ["project-files", "other-files"] {
        assert_eq!(
            std::fs::read_to_string(root.join(turn).join("copy"))?,
            "Complete retained attachment"
        );
    }
    let started = Instant::now();
    let reply =
        s.gw.delete(&format!("/projects/{project}?permanent=true"))
            .await?;
    assert_eq!(reply.status, 200, "{reply:?}");
    let navigation = s.gw.get("/navigation").await?;
    assert_eq!(navigation.status, 200, "{navigation:?}");
    assert!(!navigation.text.contains(&project), "{navigation:?}");
    wait_removed(&root.join("project-files")).await;
    assert_eq!(
        std::fs::read_to_string(root.join("other-files/copy"))?,
        "Complete retained attachment"
    );
    eprintln!(
        "project removal reclaimed 1/1 owned handoff, retained 1/1 unrelated handoff in {:?}",
        started.elapsed()
    );
    s.finish().await
}

async fn wait_removed(path: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while path.exists() {
        assert!(
            Instant::now() < deadline,
            "project owner handoff remained: {}",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
