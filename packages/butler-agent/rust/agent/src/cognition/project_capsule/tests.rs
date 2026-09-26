use std::{
    fs,
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::{
    cognition::{CognitionPathEnvironment, NativeCognitionPromptReader},
    coordination::{
        CognitionCoordinationHost, CognitionProcessStatus, CognitionWriteAcquire,
        CognitionWriteCoordinator, CoordinationResult,
    },
};

use super::{
    ProjectCapsuleService, source,
    write::{self, ProjectCapsuleLock},
};

struct TestHost;

impl CognitionCoordinationHost for TestHost {
    fn process_id(&self) -> u32 {
        std::process::id()
    }
    fn hostname(&self) -> CoordinationResult<String> {
        Ok("project-capsule-test".into())
    }
    fn process_status(&self, _pid: u64) -> CognitionProcessStatus {
        CognitionProcessStatus::Alive
    }
    fn new_uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn now_epoch_millis(&self) -> i64 {
        i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap_or(i64::MAX)
    }
    fn now_iso(&self) -> String {
        crate::js_date::format_iso_millis(self.now_epoch_millis()).unwrap()
    }
}

fn temp_root() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "butler-project-capsule-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

fn service(root: &Path) -> ProjectCapsuleService {
    ProjectCapsuleService::new(
        root.to_path_buf(),
        CognitionPathEnvironment::default(),
        Arc::new(CognitionWriteCoordinator::new(Arc::new(TestHost)).unwrap()),
    )
}

fn seed_project(root: &Path) {
    fs::create_dir_all(root.join("tasks/task-001")).unwrap();
    fs::write(
        root.join("butler.config.json"),
        serde_json::to_vec(&json!({"projects":[{
            "name":"alpha", "path":"/workspace/alpha", "description":"A project"
        }]}))
        .unwrap(),
    )
    .unwrap();
    fs::write(root.join("tasks/task-001/project"), "alpha").unwrap();
    fs::write(root.join("tasks/task-001/status"), "completed").unwrap();
    fs::write(
        root.join("tasks/task-001/request.md"),
        "Implement a durable alpha workflow.",
    )
    .unwrap();
    fs::write(
        root.join("tasks/task-001/result.md"),
        "The alpha workflow is complete.",
    )
    .unwrap();
}

#[tokio::test]
async fn registered_refresh_writes_prompt_capsule_and_releases_project_lock() {
    let root = temp_root();
    seed_project(&root);

    let service = Arc::new(service(&root));
    let cancellation = CancellationToken::new();
    let deadline = TestHost.now_epoch_millis() + 120_000;
    let report = service
        .refresh_registered(20, &cancellation, deadline)
        .await
        .unwrap();
    assert_eq!(report.considered, 1);
    assert_eq!(report.refreshed, 1);
    assert!(report.failed.is_empty());

    let path = service
        .refresh("alpha", None, &cancellation, deadline)
        .await
        .unwrap();
    assert_eq!(path, root.join("cognition/memory/projects/alpha.md"));
    let capsule = fs::read_to_string(&path).unwrap();
    assert!(capsule.contains("# Project Memory: alpha"));
    assert!(capsule.contains("/workspace/alpha"));
    assert!(capsule.contains("task:task-001"));
    let prompt =
        NativeCognitionPromptReader::new(root.clone(), CognitionPathEnvironment::default(), 1);
    assert_eq!(
        prompt.project_capsule(Some("alpha".into())).await.unwrap(),
        Some(capsule.trim().to_owned())
    );
    prompt.close().await;
    assert!(
        !root
            .join("cognition/memory/locks/project-capsules/alpha.lock")
            .exists()
    );

    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn changed_selected_source_blocks_capsule_replacement_and_releases_project_lock() {
    let root = temp_root();
    seed_project(&root);
    let paths = CognitionPathEnvironment::default();
    let cancellation = CancellationToken::new();
    let deadline = TestHost.now_epoch_millis() + 120_000;
    let project_lock: ProjectCapsuleLock =
        write::acquire_project_lock(&root, &paths, "alpha").unwrap();
    let prepared = source::prepare(&root, &paths, "alpha", None, &cancellation, deadline).unwrap();
    let target = prepared.path.clone();
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(&target, "existing capsule\n").unwrap();
    fs::write(root.join("tasks/task-001/request.md"), "A changed request.").unwrap();

    let coordinator = CognitionWriteCoordinator::new(Arc::new(TestHost)).unwrap();
    let lock_path = paths.consolidation_lock(&root);
    let lease = coordinator
        .try_acquire(&CognitionWriteAcquire::immediate(
            lock_path.clone(),
            "project_capsule_test",
        ))
        .unwrap()
        .unwrap();
    let result = write::commit(
        &root,
        &paths,
        &lock_path,
        &prepared,
        &lease,
        &cancellation,
        deadline,
    );
    lease.release(result.is_ok()).unwrap();
    drop(project_lock);

    assert_eq!(result.unwrap_err().code, "memory_source_changed");
    assert_eq!(fs::read_to_string(&target).unwrap(), "existing capsule\n");
    assert!(!write::project_lock_path(&root, &paths, "alpha").exists());
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn escaped_cognition_root_is_rejected_before_any_lock_file() {
    let root = temp_root();
    let outside = temp_root();
    seed_project(&root);
    fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("cognition")).unwrap();

    let cancellation = CancellationToken::new();
    let deadline = TestHost.now_epoch_millis() + 120_000;
    let failure = service(&root)
        .refresh("alpha", None, &cancellation, deadline)
        .await
        .unwrap_err();
    assert_eq!(failure.code, "memory_data_path_unsafe");
    assert!(fs::read_dir(&outside).unwrap().next().is_none());

    let _ = fs::remove_dir_all(root);
    let _ = fs::remove_dir_all(outside);
}

#[tokio::test]
async fn cancellation_before_commit_preserves_capsule_and_releases_claims() {
    let root = temp_root();
    seed_project(&root);
    let paths = CognitionPathEnvironment::default();
    let cancellation = CancellationToken::new();
    let deadline = TestHost.now_epoch_millis() + 120_000;
    let project_lock = write::acquire_project_lock(&root, &paths, "alpha").unwrap();
    let prepared = source::prepare(&root, &paths, "alpha", None, &cancellation, deadline).unwrap();
    let target = prepared.path.clone();
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(&target, "existing capsule\n").unwrap();
    let coordinator = CognitionWriteCoordinator::new(Arc::new(TestHost)).unwrap();
    let lock_path = paths.consolidation_lock(&root);
    let lease = coordinator
        .try_acquire(&CognitionWriteAcquire::immediate(
            lock_path.clone(),
            "project_capsule_cancel_test",
        ))
        .unwrap()
        .unwrap();
    cancellation.cancel();
    let result = write::commit(
        &root,
        &paths,
        &lock_path,
        &prepared,
        &lease,
        &cancellation,
        deadline,
    );
    lease.release(result.is_ok()).unwrap();
    drop(project_lock);

    assert_eq!(result.unwrap_err().code, "memory_write_aborted");
    assert_eq!(fs::read_to_string(&target).unwrap(), "existing capsule\n");
    assert!(!write::project_lock_path(&root, &paths, "alpha").exists());
    let next_lease = coordinator
        .try_acquire(&CognitionWriteAcquire::immediate(
            lock_path,
            "project_capsule_after_cancel",
        ))
        .unwrap()
        .expect("cancelled commit releases coordinator claim");
    next_lease.release(false).unwrap();
    let _ = fs::remove_dir_all(root);
}
