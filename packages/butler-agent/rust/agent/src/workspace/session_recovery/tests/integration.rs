#![cfg(unix)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::workspace::SessionWorkspaceAuthority;
use crate::workspace::session_recovery::SessionWorkspaceValidation;
use crate::workspace::{
    NativeCommands, NativeSessionWorkspaceRecovery, NativeWorkspaceFiles, OwnOptional,
    SessionBindingStore, SessionBindingStoreConfig, SessionRole, UpsertSessionBinding,
    WorkspaceClock, WorkspaceResult, WorkspaceStorageProfile,
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

pub(super) struct Fixture {
    pub(super) root: PathBuf,
    anchor: PathBuf,
    target: PathBuf,
    pub(super) store: SessionBindingStore,
    pub(super) commands: NativeCommands,
    pub(super) files: NativeWorkspaceFiles,
}

impl Fixture {
    pub(super) async fn new() -> Self {
        let root = std::env::temp_dir().join(format!("butler-w2a-{}", uuid::Uuid::new_v4()));
        let anchor = root.join("anchor");
        let target = root.join("linked");
        std::fs::create_dir_all(&anchor).unwrap();
        git(&anchor, &["init", "-q", "-b", "main"]);
        git(&anchor, &["config", "user.email", "test@example.invalid"]);
        git(&anchor, &["config", "user.name", "W2 Test"]);
        std::fs::write(anchor.join("README"), "source\n").unwrap();
        git(&anchor, &["add", "README"]);
        git(&anchor, &["commit", "-qm", "initial"]);
        git(
            &anchor,
            &[
                "worktree",
                "add",
                "-qb",
                "feature/linked",
                target.to_str().unwrap(),
                "HEAD",
            ],
        );
        let store = Self::open(&root).await;
        let fixture = Self {
            root,
            anchor,
            target,
            store,
            commands: NativeCommands::new(),
            files: NativeWorkspaceFiles::new(2),
        };
        fixture
            .bind(&fixture.target, Some(fixture.marker("feature/linked")))
            .await;
        fixture
    }

    async fn open(root: &Path) -> SessionBindingStore {
        SessionBindingStore::open(SessionBindingStoreConfig {
            path: root.join("session-store.sqlite"),
            storage_profile: WorkspaceStorageProfile::Durable,
            clock: Arc::new(Clock),
        })
        .await
        .unwrap()
    }

    fn marker(&self, branch: &str) -> Map<String, Value> {
        Map::from_iter([(
            "sessionWorkspace".into(),
            json!({
                "schema":"butler.session-workspace-binding.v1",
                "ownership":"session",
                "repositoryAnchorPath":self.anchor,
                "branch":branch,
                "boundAt":"2026-09-19T00:00:00Z"
            }),
        )])
    }

    async fn bind(&self, path: &Path, metadata: Option<Map<String, Value>>) {
        self.store
            .upsert(UpsertSessionBinding {
                session_id: "session".into(),
                role: SessionRole::Butler,
                project_id: None,
                app_project_id: OwnOptional::Absent,
                ledger_project_id: OwnOptional::Absent,
                workspace_path: path.to_string_lossy().into_owned(),
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
                metadata,
            })
            .await
            .unwrap();
    }

    async fn rebind(store: &SessionBindingStore, path: &Path, metadata: Map<String, Value>) {
        let stored = store.get_by_session_id("session").await.unwrap().unwrap();
        let result = store
            .rebind_workspace(crate::workspace::RebindWorkspaceInput {
                session_id: "session".into(),
                expected_updated_at: stored.updated_at,
                workspace_path: path.to_string_lossy().into_owned(),
                metadata,
                updated_at: None,
            })
            .await
            .unwrap();
        assert!(matches!(
            result,
            crate::workspace::RebindWorkspaceResult::Applied(_)
        ));
    }

    fn recovery(&self, store: SessionBindingStore) -> NativeSessionWorkspaceRecovery {
        NativeSessionWorkspaceRecovery::new(
            store,
            self.commands.clone(),
            self.files.clone(),
            Arc::new(HashMap::from([(
                "PATH".into(),
                std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
            )])),
        )
    }

    pub(super) async fn close(&self) {
        self.commands.close().await;
        self.files.close().await;
        self.store.close().await.unwrap();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn git(cwd: &Path, args: &[&str]) -> String {
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
    String::from_utf8(output.stdout).unwrap()
}

#[tokio::test]
async fn actual_binding_git_worktree_reopen_dirty_and_invalid_authority() {
    let fixture = Fixture::new().await;
    let recovery = fixture.recovery(fixture.store.clone());
    let valid = recovery
        .recover("session", Some("/project"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        valid.workspace_reference.get().unwrap(),
        fixture.target.canonicalize().unwrap()
    );
    assert!(matches!(
        valid.authority,
        SessionWorkspaceAuthority::SessionWorktree { branch, workspace_label, .. }
            if branch == "feature/linked" && workspace_label == "session-worktree/feature/linked"
    ));
    assert!(matches!(
        valid.validation,
        SessionWorkspaceValidation::Valid { dirty: false, .. }
    ));
    let missing_git = NativeSessionWorkspaceRecovery::new(
        fixture.store.clone(),
        fixture.commands.clone(),
        fixture.files.clone(),
        Arc::new(HashMap::from([(
            "PATH".into(),
            "/this-path-has-no-git".into(),
        )])),
    )
    .recover("session", None, CancellationToken::new())
    .await
    .unwrap();
    let golden: Value = serde_json::from_str(include_str!("../bun-golden.json")).unwrap();
    assert_eq!(
        missing_git.workspace_reference.get().unwrap_err().code(),
        golden["missingGit"]["code"].as_str().unwrap()
    );
    fixture.store.close().await.unwrap();
    let reopened = Fixture::open(&fixture.root).await;
    let recovery = fixture.recovery(reopened.clone());
    std::fs::write(fixture.target.join("untracked"), "dirty").unwrap();
    let dirty = recovery
        .recover("session", None, CancellationToken::new())
        .await
        .unwrap();
    assert!(matches!(
        dirty.validation,
        SessionWorkspaceValidation::Valid { dirty: true, .. }
    ));

    Fixture::rebind(&reopened, &fixture.target, fixture.marker("feature/wrong")).await;
    let wrong = recovery
        .recover("session", Some("/project"), CancellationToken::new())
        .await
        .unwrap();
    assert!(matches!(
        wrong.validation,
        SessionWorkspaceValidation::Invalid {
            code: "session_workspace_unavailable"
        }
    ));
    assert_eq!(
        wrong.workspace_reference.get().unwrap_err().code(),
        "session_workspace_unavailable"
    );

    reopened.close().await.unwrap();
    fixture.close().await;
}

#[tokio::test]
async fn project_marker_missing_symlink_and_abort_keep_source_precedence() {
    let fixture = Fixture::new().await;
    let recovery = fixture.recovery(fixture.store.clone());

    Fixture::rebind(&fixture.store, &fixture.target, Map::new()).await;
    let fallback = recovery
        .recover("session", None, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(fallback.workspace_reference.get().unwrap(), fixture.target);
    let empty = recovery
        .recover("session", Some(""), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        empty.workspace_reference.get().unwrap_err().code(),
        "session_workspace_unavailable"
    );
    let preaborted = CancellationToken::new();
    preaborted.cancel();
    let project = recovery
        .recover("session", Some("/project"), preaborted)
        .await
        .unwrap();
    assert_eq!(
        project.workspace_reference.get().unwrap(),
        PathBuf::from("/project")
    );

    Fixture::rebind(
        &fixture.store,
        &fixture.target,
        Map::from_iter([("sessionWorkspace".into(), Value::Null)]),
    )
    .await;
    let invalid = recovery
        .recover("session", Some("/project"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        invalid.workspace_reference.get().unwrap_err().code(),
        "session_workspace_marker_invalid"
    );
    assert!(matches!(
        invalid.validation,
        SessionWorkspaceValidation::Invalid {
            code: "session_workspace_unavailable"
        }
    ));

    let missing = fixture.root.join("missing");
    Fixture::rebind(&fixture.store, &missing, fixture.marker("feature/linked")).await;
    let missing = recovery
        .recover("session", Some("/project"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        missing.workspace_reference.get().unwrap_err().code(),
        "session_workspace_unavailable"
    );

    let link = fixture.root.join("symlink");
    std::os::unix::fs::symlink(&fixture.target, &link).unwrap();
    Fixture::rebind(&fixture.store, &link, fixture.marker("feature/linked")).await;
    let symlink = recovery
        .recover("session", Some("/project"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        symlink.workspace_reference.get().unwrap_err().code(),
        "session_workspace_unavailable"
    );

    let stale = fixture.root.join("unlinked");
    std::fs::create_dir(&stale).unwrap();
    Fixture::rebind(&fixture.store, &stale, fixture.marker("feature/linked")).await;
    let stale = recovery
        .recover("session", Some("/project"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        stale.workspace_reference.get().unwrap_err().code(),
        "session_workspace_unavailable"
    );

    Fixture::rebind(
        &fixture.store,
        &fixture.target,
        fixture.marker("feature/linked"),
    )
    .await;
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let aborted = recovery
        .recover("session", Some("/project"), cancelled)
        .await
        .unwrap();
    assert_eq!(
        aborted.workspace_reference.get().unwrap_err().code(),
        "cancelled"
    );
    assert_eq!(fixture.commands.active_count(), 0);
    fixture.close().await;
}
