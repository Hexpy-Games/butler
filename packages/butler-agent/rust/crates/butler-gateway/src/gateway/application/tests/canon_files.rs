//! Deterministic startup interleaving over the real App SQLite/file owners.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::{Notify, watch};

#[derive(Default)]
struct FileClock {
    later: AtomicBool,
    id: AtomicU64,
}
impl AppIdentityClock for FileClock {
    fn new_uuid(&self) -> String {
        format!(
            "00000000-0000-4000-8000-{:012x}",
            self.id.fetch_add(1, Ordering::Relaxed)
        )
    }
    fn now_iso(&self) -> String {
        if self.later.load(Ordering::Relaxed) {
            "2026-10-26T00:00:00.000Z"
        } else {
            "2026-10-24T00:00:00.000Z"
        }
        .into()
    }
    fn iso_after_millis(&self, _: u64) -> String {
        if self.later.load(Ordering::Relaxed) {
            "2026-10-27T00:00:00.000Z"
        } else {
            "2026-10-25T00:00:00.000Z"
        }
        .into()
    }
}
struct Canon {
    changes: watch::Sender<()>,
    entered: Arc<Notify>,
    resume: Arc<Notify>,
    rows: Arc<Mutex<Vec<AppCanonEvent>>>,
    description: Arc<Mutex<String>>,
}
impl AppCanonPort for Canon {
    fn changes(&self) -> Option<watch::Receiver<()>> {
        Some(self.changes.subscribe())
    }
    fn reconcile(&self) -> ApplicationFuture<()> {
        let (entered, resume) = (self.entered.clone(), self.resume.clone());
        Box::pin(async move {
            entered.notify_one();
            resume.notified().await;
            Ok(())
        })
    }
    fn project_scope(&self, _: AppCanonResource, _: String) -> ApplicationFuture<String> {
        Box::pin(async { Ok("project".into()) })
    }
    fn execute(&self, request: AppCanonRequest) -> ApplicationFuture<Value> {
        let description = self.description.clone();
        let rows = self.rows.clone();
        Box::pin(async move {
            if request.resource == AppCanonResource::CreateEpic {
                let input = request.input.unwrap();
                *description.lock().unwrap() = input["description"].as_str().unwrap().into();
                rows.lock().unwrap().push(AppCanonEvent { seq: 1, topic: "canon.changed".into(),
                    payload: json!({"kind":"work","id":"epic","attachments":butler_canon::store::attachment_references(input["description"].as_str().unwrap()).unwrap()}) });
            }
            Ok(json!({"id":"epic","description":*description.lock().unwrap()}))
        })
    }
    fn unpublished(&self, after: i64) -> ApplicationFuture<Vec<AppCanonEvent>> {
        let rows = self
            .rows
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.seq > after)
            .cloned()
            .collect();
        Box::pin(async move { Ok(rows) })
    }
    fn published(&self, seqs: Vec<i64>) -> ApplicationFuture<()> {
        self.rows.lock().unwrap().retain(|r| !seqs.contains(&r.seq));
        Box::pin(async { Ok(()) })
    }
}
fn upload() -> AppFileUpload {
    AppFileUpload {
        browser_tab: None,
        owner_session_id: None,
        name: "note.txt".into(),
        mime_type: Some("text/plain".into()),
        bytes: bytes::Bytes::from_static(b"complete notes"),
    }
}

// test-category: race
#[tokio::test]
async fn startup_upload_waits_to_expire_until_relay_and_missing_files_do_not_stop_events() {
    let root = std::env::temp_dir().join(format!("canon-startup-{}", uuid::Uuid::new_v4()));
    let config = || AppApplicationConfig {
        database_path: root.join("app.sqlite"),
        butler_data: root.clone(),
        folder_selection_secret: None,
    };
    let clock = Arc::new(FileClock::default());
    let files = Arc::new(crate::gateway::AppMessageFiles::new(&root, clock.clone()));
    let canon = Arc::new(Canon {
        changes: watch::channel(()).0,
        entered: Arc::new(Notify::new()),
        resume: Arc::new(Notify::new()),
        rows: Arc::default(),
        description: Arc::default(),
    });
    let deps = || {
        let mut deps = dependencies(Arc::new(Native(Mutex::new(Vec::new()))), 1);
        deps.identity_clock = clock.clone();
        deps.message_files = files.clone();
        deps.canon = canon.clone();
        deps
    };
    let app = AppApplication::open(config(), deps()).await.unwrap();
    app.storage.execute(|db| {
        db.execute("INSERT INTO projects(id,display_name,status,workspace_path,workspace_label,safe_path_label,created_at,updated_at) VALUES('project','Project','ready','','','','now','now')", []).map_err(AppStorageError::sqlite)?;
        Ok(())
    }).await.unwrap();
    let saved = canon::files::upload(&app, "project".into(), upload())
        .await
        .unwrap();
    let result = canon::execute(
        &app,
        AppCanonRequest {
            resource: AppCanonResource::CreateEpic,
            id: "project".into(),
            input: Some(json!({"description":format!("[notes](attachment:{})", saved.file_id)})),
        },
    )
    .await
    .unwrap();
    assert_eq!(result["attachments"][0]["file_id"], saved.file_id);
    app.close().await.unwrap(); // No relay has run: the committed outbox survives restart.
    clock.later.store(true, Ordering::Relaxed);
    canon.rows.lock().unwrap().extend([
        AppCanonEvent { seq: 2, topic: "canon.changed".into(), payload: json!({"kind":"work","id":"missing","attachments":["file-00000000-0000-4000-8000-000000000099"]}) },
        AppCanonEvent { seq: 3, topic: "canon.changed".into(), payload: json!({"kind":"tag","id":"later"}) },
    ]);
    let app = AppApplication::open(config(), deps()).await.unwrap();
    canon::start(&app);
    canon.entered.notified().await;
    let fresh = canon::files::upload(&app, "project".into(), upload())
        .await
        .unwrap();
    assert!(
        app.download_message_file(saved.file_id.clone())
            .await
            .is_ok()
    );
    canon.resume.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !*app.canon_file_lifetimes.lock().await {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let epic = canon::execute(
        &app,
        AppCanonRequest {
            resource: AppCanonResource::Epic,
            id: "epic".into(),
            input: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(epic["attachments"][0]["file_id"], saved.file_id);
    assert!(app.download_message_file(fresh.file_id).await.is_ok());
    assert_eq!(
        app.download_message_file(saved.file_id)
            .await
            .unwrap()
            .bytes,
        b"complete notes"[..]
    );
    app.storage
        .read(|db| {
            assert_eq!(
                db.query_row(
                    "SELECT count(*) FROM events WHERE type='canon.changed'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                3
            );
            assert_eq!(
                db.query_row(
                    "SELECT count(*) FROM events WHERE type='stream.reconcile_required'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
            Ok(())
        })
        .await
        .unwrap();
    app.dependencies.service_shutdown.cancel();
    app.close().await.unwrap();
    files.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
