#![cfg(unix)]

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use chrono::{DateTime, SecondsFormat, Utc};
use tokio_util::sync::CancellationToken;

use super::{
    BindSessionWorktreeInput, BindSessionWorktreeResult, NativeSessionWorktrees,
    SessionWorktreeAction,
};
use crate::workspace::{
    NativeCommands, NativeSessionWorkspaceRecovery, NativeWorkspaceFiles, OwnOptional,
    SessionBindingStore, SessionBindingStoreConfig, SessionRole, UpsertSessionBinding,
    WorkspaceClock, WorkspaceReference, WorkspaceResult, WorkspaceStorageProfile,
};

struct Clock;
impl WorkspaceClock for Clock {
    fn now_epoch_millis(&self) -> i64 {
        1_757_808_000_000
    }
    fn parse_iso_millis(&self, value: &str) -> Option<i64> {
        DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|value| value.timestamp_millis())
    }
    fn iso_from_epoch_millis(&self, value: i64) -> WorkspaceResult<String> {
        Ok(DateTime::<Utc>::from_timestamp_millis(value)
            .unwrap()
            .to_rfc3339_opts(SecondsFormat::Millis, true))
    }
}

fn git(cwd: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?}: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn create_select_persists_cas_and_reopens_one_real_worktree() {
    let root =
        std::env::temp_dir().join(format!("butler-session-worktree-{}", uuid::Uuid::new_v4()));
    let anchor = root.join("anchor");
    let data = root.join("data");
    std::fs::create_dir_all(&anchor).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    git(&anchor, &["init", "-q", "-b", "main"]);
    git(&anchor, &["config", "user.email", "test@example.invalid"]);
    git(&anchor, &["config", "user.name", "Worktree Test"]);
    std::fs::write(anchor.join("README"), "source\n").unwrap();
    git(&anchor, &["add", "README"]);
    git(&anchor, &["commit", "-qm", "initial"]);
    let clock: Arc<dyn WorkspaceClock> = Arc::new(Clock);
    let store = SessionBindingStore::open(SessionBindingStoreConfig {
        path: root.join("session.sqlite"),
        storage_profile: WorkspaceStorageProfile::Durable,
        clock: Arc::clone(&clock),
    })
    .await
    .unwrap();
    store
        .upsert(UpsertSessionBinding {
            session_id: "session".into(),
            role: SessionRole::Butler,
            project_id: None,
            app_project_id: OwnOptional::Absent,
            ledger_project_id: OwnOptional::Absent,
            workspace_path: anchor.to_string_lossy().into_owned(),
            runtime_adapter_id: "native".into(),
            model_provider_id: "test".into(),
            model_ref: "test".into(),
            runtime_session_ref: None,
            provider_thread_ref: None,
            transport_bindings: Vec::new(),
            lifecycle_state: None,
            created_at: None,
            updated_at: Some("2026-09-19T00:00:00Z".into()),
            last_active_at: None,
            metadata: None,
        })
        .await
        .unwrap();
    let commands = NativeCommands::new();
    let files = NativeWorkspaceFiles::new(2);
    let env = Arc::new(HashMap::from([(
        "PATH".into(),
        std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
    )]));
    let binder = NativeSessionWorktrees::new(
        store.clone(),
        commands.clone(),
        files.clone(),
        Arc::clone(&env),
        data,
        clock,
    );
    let reference = WorkspaceReference::new(&anchor);
    let create = binder
        .bind(BindSessionWorktreeInput {
            action: SessionWorktreeAction::Create,
            branch: "feature/session".into(),
            start_point: Some("HEAD".into()),
            session_id: "session".into(),
            project_name: Some("Project".into()),
            workspace_reference: reference.clone(),
            abort: CancellationToken::new(),
        })
        .await
        .unwrap();
    assert!(matches!(
        create,
        BindSessionWorktreeResult::Bound {
            idempotent: false,
            dirty: false,
            source_dirty: false,
            ..
        }
    ));
    let bound = store.get_by_session_id("session").await.unwrap().unwrap();
    assert_eq!(
        reference.get().unwrap().as_path(),
        Path::new(&bound.workspace_path)
    );
    assert_eq!(
        bound.metadata.as_ref().unwrap()["sessionWorkspace"]["branch"],
        "feature/session"
    );
    let select = binder
        .bind(BindSessionWorktreeInput {
            action: SessionWorktreeAction::Select,
            branch: "feature/session".into(),
            start_point: None,
            session_id: "session".into(),
            project_name: None,
            workspace_reference: reference.clone(),
            abort: CancellationToken::new(),
        })
        .await
        .unwrap();
    assert!(matches!(
        select,
        BindSessionWorktreeResult::Bound {
            idempotent: true,
            ..
        }
    ));
    binder.close().await;
    store.close().await.unwrap();
    let reopened_store = SessionBindingStore::open(SessionBindingStoreConfig {
        path: root.join("session.sqlite"),
        storage_profile: WorkspaceStorageProfile::Durable,
        clock: Arc::new(Clock),
    })
    .await
    .unwrap();
    let recovery = NativeSessionWorkspaceRecovery::new(
        reopened_store.clone(),
        commands.clone(),
        files.clone(),
        env,
    );
    let reopened = recovery
        .recover("session", None, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        reopened.workspace_reference.get().unwrap(),
        reference.get().unwrap()
    );
    commands.close().await;
    files.close().await;
    reopened_store.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
