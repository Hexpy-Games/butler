use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{PlanRecordRead, ProjectLedger, ProjectLedgerReadError};

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
    fn native(&self) -> ProjectLedger {
        ProjectLedger::new(&self.data, 1)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.data).ok();
    }
}

/// Security boundary: ledger root discovery prefers the initialized candidate
/// and refuses path escapes.
// test-category: security
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
            Err(ProjectLedgerReadError::resolution(
                "active_project_ledger_path_escape"
            ))
        );
    }
    native.close().await;
}

/// Race: while a command holds its ledger claim, readers keep seeing the
/// before-image until the claim is released.
// test-category: race
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
