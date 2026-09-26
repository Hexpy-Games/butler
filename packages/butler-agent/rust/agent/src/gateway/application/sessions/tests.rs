use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use super::*;
use crate::gateway::application::{AppIdentityClock, EventSubscribers, storage::AppStorage};

struct Clock(AtomicU64);
impl AppIdentityClock for Clock {
    fn new_uuid(&self) -> String {
        format!(
            "00000000-0000-4000-8000-{:012x}",
            self.0.fetch_add(1, Ordering::Relaxed)
        )
    }
    fn now_iso(&self) -> String {
        let second = self.0.fetch_add(1, Ordering::Relaxed);
        format!("2026-09-20T00:00:{second:02}.000Z")
    }
    fn iso_after_millis(&self, _: u64) -> String {
        self.now_iso()
    }
}

#[tokio::test]
async fn local_and_project_session_rows_follow_app_source() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root =
        std::env::temp_dir().join(format!("butler-app-session-{}-{nonce}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let storage = AppStorage::open(
        root.join("app.sqlite"),
        Some(root.clone()),
        "2026-09-20T00:00:00.000Z".into(),
    )
    .await
    .unwrap();
    let subscribers = EventSubscribers::default();
    let clock = Clock(AtomicU64::new(1));
    storage.execute(|db| {
        db.execute("INSERT INTO projects(id,display_name,status,workspace_path,workspace_label,safe_path_label,created_at,updated_at) VALUES('p1','Project','active','/tmp/project','Project','Project','2026-09-20T00:00:00.000Z','2026-09-20T00:00:00.000Z')", [])
            .map_err(AppStorageError::sqlite)?;
        Ok(())
    }).await.unwrap();
    let local = storage
        .execute({
            let subscribers = subscribers.clone();
            move |db| {
                write::create(
                    db,
                    &subscribers,
                    AppCreateSessionInput {
                        kind: AppChatKind::Chat,
                        title: None,
                        project_id: Some("ignored".into()),
                        session_hint: Some(" My Chat ".into()),
                    },
                    &clock,
                    true,
                )
            }
        })
        .await
        .unwrap();
    assert_eq!(local.id, "my-chat");
    assert_eq!(local.title, "New chat");
    assert_eq!(local.session_hint, "butler/app-my-chat");
    let project = storage
        .execute({
            let subscribers = subscribers.clone();
            move |db| {
                write::create(
                    db,
                    &subscribers,
                    AppCreateSessionInput {
                        kind: AppChatKind::Project,
                        title: Some(" Build ".into()),
                        project_id: Some(" p1 ".into()),
                        session_hint: Some(" Project Chat ".into()),
                    },
                    &Clock(AtomicU64::new(10)),
                    false,
                )
            }
        })
        .await
        .unwrap();
    assert_eq!(project.id, "project-chat");
    assert_eq!(project.title, "Build");
    assert_eq!(project.project_id.as_deref(), Some("p1"));
    let sessions = storage
        .execute(|db| read::sessions(db, None, None))
        .await
        .unwrap();
    assert_eq!(
        sessions
            .iter()
            .map(|session| session.id.as_str())
            .collect::<Vec<_>>(),
        vec!["project-chat", "my-chat", "general"]
    );
    let chats = storage.execute(read::chats).await.unwrap();
    assert_eq!(
        chats
            .iter()
            .map(|chat| chat.id.as_str())
            .collect::<Vec<_>>(),
        vec!["project-chat", "my-chat", "general"]
    );
    storage
        .execute({
            let subscribers = subscribers.clone();
            move |db| write::publish(db, &subscribers, "project-chat", &Clock(AtomicU64::new(12)))
        })
        .await
        .unwrap();
    let created = storage
        .execute(|db| {
            db.query_row(
                "SELECT COUNT(*) FROM events WHERE type='session.created'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(AppStorageError::sqlite)
        })
        .await
        .unwrap();
    assert_eq!(created, 2);
    storage
        .execute(|db| write::rollback(db, "project-chat"))
        .await
        .unwrap();
    let remaining = storage
        .execute(|db| read::sessions(db, None, None))
        .await
        .unwrap();
    assert_eq!(remaining.len(), 2);
    storage.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
