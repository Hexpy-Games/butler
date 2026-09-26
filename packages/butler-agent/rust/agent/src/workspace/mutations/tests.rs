use std::path::Path;
use std::sync::Arc;

use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
    CommitObserver, WorkspaceMutations,
    contracts::{EditMutation, ExactEdit, MutationCommand, MutationContext, MutationOutcome},
};
use super::{contracts::GuardedPath, io};

/// Runs `action` at one commit point of the lane.
struct At<F>(F);

struct BeforeTarget<F: Fn(usize, &Path) + Send + Sync>(F);
impl<F: Fn(usize, &Path) + Send + Sync> CommitObserver for BeforeTarget<F> {
    fn before_target(&self, index: usize, target: &Path) {
        (self.0)(index, target);
    }
}

impl<F: Fn(&Path) + Send + Sync> CommitObserver for At<(Point, F)> {
    fn before_replace(&self, target: &Path) {
        if matches!(self.0.0, Point::BeforeReplace) {
            (self.0.1)(target);
        }
    }
    fn after_link(&self, temporary: &Path) {
        if matches!(self.0.0, Point::AfterLink) {
            (self.0.1)(temporary);
        }
    }
}

enum Point {
    BeforeReplace,
    AfterLink,
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[tokio::test]
async fn batch_retains_first_commit_and_reports_second_external_change() {
    let root = std::env::temp_dir().join(format!("butler-k1b-partial-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("first.txt"), b"before-one").unwrap();
    std::fs::write(root.join("second.txt"), b"before-two").unwrap();
    let owner = WorkspaceMutations::observed(Arc::new(BeforeTarget(|index, path: &Path| {
        if index == 1 {
            std::fs::write(path, b"outside-change").unwrap();
        }
    })));
    let commands = [
        ("first.txt", "before-one", "after-one"),
        ("second.txt", "before-two", "after-two"),
    ]
    .into_iter()
    .enumerate()
    .map(|(index, (path, before, after))| ExactEdit {
        index,
        path: path.into(),
        old_text: before.into(),
        new_text: after.into(),
        start_line: None,
        expected_sha256: Some(sha(before.as_bytes())),
    })
    .collect();
    let command = MutationCommand::Edit(EditMutation {
        context: MutationContext {
            root: root.clone(),
            relative_only: false,
            installation_root: None,
            protected_roots: Vec::new(),
        },
        edits: commands,
        batch: true,
    });
    let (outcome, _) = owner.submit(command).unwrap().await.unwrap().unwrap();
    let MutationOutcome::Batch(result) = outcome else {
        panic!("batch outcome")
    };
    assert_eq!(result.error, Some("partial_apply"));
    assert_eq!(result.applied.len(), 1);
    assert_eq!(result.applied[0].committed.path, "first.txt");
    assert_eq!(result.conflicting.len(), 1);
    assert_eq!(result.conflicting[0].error, "external_change_conflict");
    assert_eq!(std::fs::read(root.join("first.txt")).unwrap(), b"after-one");
    assert_eq!(
        std::fs::read(root.join("second.txt")).unwrap(),
        b"outside-change"
    );
    owner.close().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn exclusive_create_race_keeps_external_bytes_and_cleans_temp() {
    let root = std::env::temp_dir().join(format!("butler-k1b-create-race-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let absolute = root.join("target.txt");
    let snapshot = io::observe(
        GuardedPath {
            public: "target.txt".into(),
            absolute: absolute.clone(),
            real: absolute.clone(),
        },
        false,
    )
    .unwrap();
    let prepared = io::prepare(snapshot, b"ours".to_vec(), None, true).unwrap();
    let external = At((Point::BeforeReplace, |path: &Path| {
        std::fs::write(path, b"external").unwrap();
    }));
    let failure = io::commit(prepared, &external).unwrap_err();
    assert_eq!(failure.error, "external_change_conflict");
    assert_eq!(std::fs::read(&absolute).unwrap(), b"external");
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn committed_hardlink_cleanup_failure_remains_applied_success() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("butler-k1b-cleanup-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let absolute = root.join("target.txt");
    let snapshot = io::observe(
        GuardedPath {
            public: "target.txt".into(),
            absolute: absolute.clone(),
            real: absolute.clone(),
        },
        false,
    )
    .unwrap();
    let prepared = io::prepare(snapshot, b"committed".to_vec(), None, true).unwrap();
    let locked = root.clone();
    let lock_directory = At((Point::AfterLink, move |_: &Path| {
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o500)).unwrap();
    }));
    let result = io::commit(prepared, &lock_directory).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.cleanup_failed);
    assert_eq!(std::fs::read(&absolute).unwrap(), b"committed");
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 2);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn close_drains_running_and_queued_mutations_after_callers_drop() {
    let root = std::env::temp_dir().join(format!("butler-k1b-drain-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("first.txt"), b"one").unwrap();
    std::fs::write(root.join("second.txt"), b"two").unwrap();
    let context = || MutationContext {
        root: root.clone(),
        relative_only: false,
        installation_root: None,
        protected_roots: Vec::new(),
    };
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release_rx = std::sync::Mutex::new(release_rx);
    let first = MutationCommand::Edit(EditMutation {
        context: context(),
        batch: true,
        edits: [("first.txt", "one", "three"), ("second.txt", "two", "four")]
            .into_iter()
            .enumerate()
            .map(|(index, (path, old, new))| ExactEdit {
                index,
                path: path.into(),
                old_text: old.into(),
                new_text: new.into(),
                start_line: None,
                expected_sha256: Some(sha(old.as_bytes())),
            })
            .collect(),
    });
    let started_tx = std::sync::Mutex::new(started_tx);
    let owner = WorkspaceMutations::observed(Arc::new(BeforeTarget(move |index, _: &Path| {
        if index == 0 {
            started_tx.lock().unwrap().send(()).unwrap();
            release_rx.lock().unwrap().recv().unwrap();
        }
    })));
    drop(owner.submit(first).unwrap());
    tokio::task::spawn_blocking(move || started_rx.recv().unwrap())
        .await
        .unwrap();
    let queued = MutationCommand::Write(super::contracts::WriteMutation {
        context: context(),
        path: "queued.txt".into(),
        content: "queued".into(),
        overwrite: false,
        create_parents: false,
        expected_sha256: None,
    });
    drop(owner.submit(queued).unwrap());
    assert_eq!(owner.active_count(), 2);
    let closing = owner.clone();
    let join = tokio::spawn(async move { closing.close().await });
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    let rejected = MutationCommand::Write(super::contracts::WriteMutation {
        context: context(),
        path: "rejected.txt".into(),
        content: "no".into(),
        overwrite: false,
        create_parents: false,
        expected_sha256: None,
    });
    assert!(
        matches!(owner.submit(rejected), Err(error) if error.code() == "workspace_mutations_closed")
    );
    release_tx.send(()).unwrap();
    join.await.unwrap();
    assert_eq!(owner.active_count(), 0);
    assert_eq!(std::fs::read(root.join("first.txt")).unwrap(), b"three");
    assert_eq!(std::fs::read(root.join("second.txt")).unwrap(), b"four");
    assert_eq!(std::fs::read(root.join("queued.txt")).unwrap(), b"queued");
    assert!(!root.join("rejected.txt").exists());
    std::fs::remove_dir_all(root).unwrap();
}
