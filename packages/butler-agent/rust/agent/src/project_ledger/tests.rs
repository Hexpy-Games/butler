use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use super::{NativeProjectLedger, PlanRecordRead, ProjectLedgerReadError};

struct Fixture {
    data: PathBuf,
    workspace: PathBuf,
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let data =
            std::env::temp_dir().join(format!("butler-plan-native-{}", uuid::Uuid::new_v4()));
        let workspace = data.join("workspace");
        let root = data.join("project-ledger/projects/demo");
        fs::create_dir_all(workspace.clone()).unwrap();
        fs::create_dir_all(root.join("plans")).unwrap();
        let source: Value = serde_json::from_str(include_str!("tests/source-plan.json")).unwrap();
        for (key, path) in [
            ("project", "project.json"),
            ("ledger", "ledger.jsonl"),
            ("active", "plans/plan-1.md"),
            ("draft", "plans/plan-2.md"),
            ("closed", "plans/plan-3.md"),
        ] {
            fs::write(root.join(path), source[key].as_str().unwrap()).unwrap();
        }
        fs::write(workspace.join("project.json"), r#"{"id":"demo"}"#).unwrap();
        Self {
            data,
            workspace,
            root,
        }
    }
    fn input(&self, plan_id: &str) -> PlanRecordRead {
        PlanRecordRead {
            workspace_path: self.workspace.to_string_lossy().into_owned(),
            app_project_id: "demo".into(),
            plan_id: plan_id.into(),
        }
    }
    fn native(&self) -> NativeProjectLedger {
        NativeProjectLedger::new(&self.data, 1)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.data).ok();
    }
}

#[tokio::test]
async fn source_writer_records_full_set_and_projection_inputs() {
    let fixture = Fixture::new();
    assert_eq!(
        super::committed::read_all(&fixture.root)
            .unwrap()
            .iter()
            .filter(|(path, _)| path == "project.json")
            .count(),
        1
    );
    let native = fixture.native();
    let active = native
        .show_plan_record(fixture.input("PLAN-1"))
        .await
        .unwrap();
    assert_eq!(active.id, "PLAN-1");
    assert_eq!(active.status, "active");
    assert_eq!(active.body.as_deref(), Some("Source Plan body\nline two\n"));
    assert_eq!(
        active.path.as_deref(),
        Some("project-ledger/projects/demo/plans/plan-1.md")
    );
    assert_eq!(
        native
            .show_plan_record(fixture.input("PLAN-2"))
            .await
            .unwrap()
            .status,
        "draft"
    );
    assert_eq!(
        native
            .show_plan_record(fixture.input("PLAN-3"))
            .await
            .unwrap()
            .status,
        "closed"
    );
    assert_eq!(
        native
            .show_plan_record(fixture.input(" PLAN-1 "))
            .await
            .unwrap()
            .id,
        "PLAN-1"
    );
    assert_eq!(
        native.show_plan_record(fixture.input("MISSING")).await,
        Err(ProjectLedgerReadError::RecordShow("record_not_found"))
    );
    native.close().await;
}

#[tokio::test]
async fn duplicate_and_unrelated_malformed_record_block_show() {
    let fixture = Fixture::new();
    let native = fixture.native();
    fs::create_dir_all(fixture.root.join("reports")).unwrap();
    fs::write(
        fixture.root.join("reports/duplicate.md"),
        fs::read(fixture.root.join("plans/plan-1.md")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        native.show_plan_record(fixture.input("PLAN-1")).await,
        Err(ProjectLedgerReadError::RecordShow("ambiguous_record"))
    );
    fs::remove_file(fixture.root.join("reports/duplicate.md")).unwrap();
    fs::create_dir_all(fixture.root.join("references")).unwrap();
    fs::write(fixture.root.join("references/bad.json"), "{invalid").unwrap();
    assert_eq!(
        native.show_plan_record(fixture.input("PLAN-1")).await,
        Err(ProjectLedgerReadError::RecordShow("invalid_record_json"))
    );
    fs::remove_file(fixture.root.join("references/bad.json")).unwrap();
    fs::write(fixture.root.join("plans/plan-4.json"), "false").unwrap();
    assert_eq!(
        native.show_plan_record(fixture.input("plan-4")).await,
        Err(ProjectLedgerReadError::RecordShow("record_not_found"))
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(
            fixture.root.join("plans/plan-1.md"),
            fixture.root.join("references/alias.md"),
        )
        .unwrap();
        assert_eq!(
            native.show_plan_record(fixture.input("PLAN-1")).await,
            Err(ProjectLedgerReadError::RecordShow(
                "publication_record_is_symlink"
            ))
        );
    }
    native.close().await;
}

#[tokio::test]
async fn initialized_candidate_preference_and_path_escape() {
    let fixture = Fixture::new();
    let native = fixture.native();
    fs::write(
        fixture.workspace.join("project.json"),
        r#"{"id":"uninitialized"}"#,
    )
    .unwrap();
    assert_eq!(
        native
            .show_plan_record(fixture.input("PLAN-1"))
            .await
            .unwrap()
            .id,
        "PLAN-1"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        fs::create_dir_all(fixture.data.join("outside")).unwrap();
        symlink(
            fixture.data.join("outside"),
            fixture.data.join("project-ledger/projects/escape"),
        )
        .unwrap();
        fs::write(fixture.workspace.join("project.json"), r#"{"id":"escape"}"#).unwrap();
        assert_eq!(
            native.show_plan_record(fixture.input("PLAN-1")).await,
            Err(ProjectLedgerReadError::Resolution(
                "active_project_ledger_path_escape"
            ))
        );
    }
    native.close().await;
}

#[tokio::test]
async fn before_image_remains_authoritative_until_claim_release() {
    let fixture = Fixture::new();
    let native = fixture.native();
    let publication: Value =
        serde_json::from_str(include_str!("tests/source-publication.json")).unwrap();
    assert_eq!(
        publication["claim"]["schema"],
        "project-ledger.publication-claim.v1"
    );
    assert_eq!(publication["journal"]["status"], "promoted");
    let candidate = fixture.data.join("candidate");
    let before = PathBuf::from(format!("{}.before", candidate.display()));
    fs::create_dir_all(before.join("plans")).unwrap();
    fs::write(
        before.join("plans/plan-1.md"),
        publication["before"].as_str().unwrap(),
    )
    .unwrap();
    fs::write(
        before.join("project.json"),
        fs::read(fixture.root.join("project.json")).unwrap(),
    )
    .unwrap();
    fs::write(
        fixture.root.join("plans/plan-1.md"),
        publication["current"].as_str().unwrap(),
    )
    .unwrap();
    let journal = fixture.data.join("journal.json");
    let claim = claim_path(&fixture.root);
    fs::create_dir_all(claim.parent().unwrap()).unwrap();
    fs::write(
        &claim,
        substitute_publication_paths(
            &publication["claim"],
            &fixture.root,
            &candidate,
            &journal,
            &claim,
        ),
    )
    .unwrap();
    let source_journal: Value = serde_json::from_str(&substitute_publication_paths(
        &publication["journal"],
        &fixture.root,
        &candidate,
        &journal,
        &claim,
    ))
    .unwrap();
    for (status, expected) in [
        ("prepared", "closed"),
        ("committing", "active"),
        ("promoted", "active"),
        ("observed", "active"),
    ] {
        let mut state = source_journal.clone();
        state["status"] = Value::String(status.into());
        fs::write(&journal, state.to_string()).unwrap();
        assert_eq!(
            native
                .show_plan_record(fixture.input("PLAN-1"))
                .await
                .unwrap()
                .status,
            expected
        );
    }
    fs::remove_file(claim).unwrap();
    assert_eq!(
        native
            .show_plan_record(fixture.input("PLAN-1"))
            .await
            .unwrap()
            .status,
        "closed"
    );
    native.close().await;
}

#[tokio::test]
async fn dropped_caller_keeps_admitted_read_owned_and_close_drains() {
    let fixture = Fixture::new();
    let native = fixture.native();
    let entered = Arc::new(std::sync::Barrier::new(2));
    let release = Arc::new(std::sync::Barrier::new(2));
    let caller = tokio::spawn({
        let native = native.clone();
        let (entered, release) = (Arc::clone(&entered), Arc::clone(&release));
        async move {
            native
                .run(move |_, _| {
                    entered.wait();
                    release.wait();
                    Ok(())
                })
                .await
        }
    });
    tokio::task::spawn_blocking(move || entered.wait())
        .await
        .unwrap();
    caller.abort();
    let mut closing = tokio::spawn({
        let native = native.clone();
        async move { native.close().await }
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), &mut closing)
            .await
            .is_err(),
        "close finished while an admitted read was running"
    );
    tokio::task::spawn_blocking(move || release.wait())
        .await
        .unwrap();
    closing.await.unwrap();
    assert_eq!(
        native.show_plan_record(fixture.input("PLAN-1")).await,
        Err(ProjectLedgerReadError::Owner("project_ledger_closed"))
    );
}

fn claim_path(root: &Path) -> PathBuf {
    root.parent()
        .unwrap()
        .join(".project-ledger-locks/demo.lock")
}

fn substitute_publication_paths(
    value: &Value,
    root: &Path,
    candidate: &Path,
    journal: &Path,
    claim: &Path,
) -> String {
    value
        .to_string()
        .replace("$ROOT", &root.to_string_lossy())
        .replace("$CANDIDATE", &candidate.to_string_lossy())
        .replace("$JOURNAL", &journal.to_string_lossy())
        .replace("$CLAIM", &claim.to_string_lossy())
}

#[test]
fn changed_read_set_and_publication_version_retry_without_extending_three_attempts() {
    let fixture = Fixture::new();
    let plan = fixture.root.join("plans/plan-1.md");
    let raw = fs::read_to_string(&plan).unwrap();
    let mut reads = 0;
    let result = super::committed::read_all_with_hook(&fixture.root, || {
        reads += 1;
        if reads == 1 {
            fs::write(
                &plan,
                raw.replace("status: \"active\"", "status: \"closed\""),
            )
            .unwrap();
        }
    })
    .unwrap();
    assert_eq!(reads, 2);
    assert!(result.iter().any(|(path, raw)| path == "plans/plan-1.md"
        && raw.as_deref().unwrap().contains("status: \"closed\"")));

    let claim = claim_path(&fixture.root);
    fs::create_dir_all(claim.parent().unwrap()).unwrap();
    let mut attempts = 0;
    let result = super::committed::read_all_with_hook(&fixture.root, || {
        attempts += 1;
        if attempts == 1 {
            fs::write(&claim, "{}").unwrap();
        }
    })
    .unwrap();
    assert_eq!(attempts, 2);
    assert!(result.iter().any(|(path, _)| path == "plans/plan-1.md"));

    let mut unstable = 0;
    let error = super::committed::read_all_with_hook(&fixture.root, || {
        unstable += 1;
        fs::write(&claim, format!("{{\"revision\":{unstable}}}")).unwrap();
    })
    .unwrap_err();
    assert_eq!(unstable, 3);
    assert_eq!(
        error,
        ProjectLedgerReadError::RecordShow("project_ledger_changed_during_record_read")
    );
}
