use super::*;
use crate::btcc::effects::workspace_file::WorkspaceFileEffectAdapter;
use crate::capabilities::NativeCapabilities;
use crate::host::{NativeRegisteredWrite, RegisteredWriteContext};
use crate::workspace::{EffectFileScope, NativeWorkspaceFiles, WorkspaceMutations};

struct WorkspaceRoot(std::path::PathBuf);
impl Drop for WorkspaceRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn actual_registered_write_commits_then_effect_reopens_without_second_write() {
    let (_fixture, storage, work) = ready("effect-real-registered-write").await;
    ToolJournalRepository::new(storage.clone(), clock())
        .start(ToolJournalStart {
            turn_id: "turn".into(),
            call_id: "effect-call".into(),
            tool_name: "write_file".into(),
            raw_arguments: "{}".into(),
            arguments: json!({}),
        })
        .await
        .unwrap();
    let root = WorkspaceRoot(
        std::env::temp_dir().join(format!("butler-b2c2-registered-{}", uuid::Uuid::new_v4())),
    );
    std::fs::create_dir(&root.0).unwrap();
    let files = Arc::new(NativeWorkspaceFiles::new(1));
    let mutations = Arc::new(WorkspaceMutations::new());
    let capabilities = Arc::new(NativeCapabilities::new(
        Arc::clone(&files),
        Arc::clone(&mutations),
    ));
    let scope = EffectFileScope {
        workspace: root.0.clone(),
        butler_data: root.0.join("data"),
        protected_roots: vec![],
        installation_root: None,
    };
    let registered = Arc::new(NativeRegisteredWrite::new(
        capabilities,
        RegisteredWriteContext {
            workspace_reference: None,
            workspace_path: root.0.clone(),
            butler_data: root.0.join("data"),
            protected_ledger_roots: vec![],
            allowed_tools_and_effects: Some(vec!["write_file:workspace".into()]),
            mutation_scope: Some(vec![".".into()]),
            installation_root: None,
        },
    ));
    let adapter: Arc<dyn EffectAdapter> =
        Arc::new(WorkspaceFileEffectAdapter::new(scope, registered));
    let input = || ExecuteEffect {
        work: work.clone(),
        access: Access::Full,
        occurrence_id: Some("effect-call".into()),
        signal: CancellationToken::new(),
        target: "workspace:a".into(),
        input: json!({"path":"a","content":"actual native bytes"}),
        adapter: Arc::clone(&adapter),
    };
    let journal = Arc::new(StorageEffectJournal::new(storage.clone(), clock()));
    let first = NativeEffectService::new(journal, clock())
        .execute(input())
        .await
        .unwrap();
    assert!(
        matches!(
            first,
            EffectOutcome::Applied {
                replayed: false,
                ..
            }
        ),
        "{first:?}"
    );
    assert_eq!(
        std::fs::read(root.0.join("a")).unwrap(),
        b"actual native bytes"
    );
    storage.close().await.unwrap();

    // A replay against an absent current target demonstrates no second write.
    std::fs::remove_file(root.0.join("a")).unwrap();
    let reopened = BtccStorage::open(_fixture.config("effect-registered-reopen"))
        .await
        .unwrap();
    let replay = NativeEffectService::new(
        Arc::new(StorageEffectJournal::new(reopened.clone(), clock())),
        clock(),
    )
    .execute(input())
    .await
    .unwrap();
    assert!(
        matches!(replay, EffectOutcome::Applied { replayed: true, .. }),
        "{replay:?}"
    );
    assert!(!root.0.join("a").exists());
    reopened.close().await.unwrap();
    mutations.close().await;
    files.close().await;
}
