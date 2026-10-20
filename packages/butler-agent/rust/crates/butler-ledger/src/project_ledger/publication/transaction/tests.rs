//! Interrupted sparse publications keep their before-image until a receipt is durable.
use super::*;
use crate::project_ledger::publication::contracts::{
    ProjectLedgerRecordKind, ProjectLedgerRecordOperation,
};
use butler_turn::btcc::{ProjectWorkOperationIdentity, ProjectWorkOperationKind};
use sha2::{Digest, Sha256};

struct Fixture {
    data: PathBuf,
    scope: ResolvedProjectWorkScope,
    collation: butler_core::locale::LocaleCollation,
    occurrence: Occurrence,
    updates: Vec<ProjectLedgerRecordUpdate>,
}

impl Fixture {
    fn new(legacy: bool) -> Self {
        let data =
            std::env::temp_dir().join(format!("publication-recovery-{}", uuid::Uuid::new_v4()));
        let root = data.join("project-ledger/projects/project");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("project.json"), r#"{"id":"project"}"#).unwrap();
        let scope = ResolvedProjectWorkScope {
            app_project_id: "app".into(),
            ledger_project_id: "project".into(),
            ledger_root: root,
        };
        let collation = butler_core::locale::LocaleCollation::new("en-US").unwrap();
        let mut updates = ["PLAN-A", "PLAN-B"]
            .into_iter()
            .map(|id| {
                let mut update = ProjectLedgerRecordUpdate::new(id.into());
                update.kind = Some(ProjectLedgerRecordKind::Plan);
                update.operation = Some(ProjectLedgerRecordOperation::Create);
                update.title = Some(id.into());
                update.status = Some("active".into());
                update.sections.spec = Some("preserve every record".into());
                update.body = Some("old".into());
                update
            })
            .collect::<Vec<_>>();
        record::materialize(&scope.ledger_root, &scope, &updates).unwrap();
        for update in &mut updates {
            update.operation = Some(ProjectLedgerRecordOperation::Update);
            update.body = Some("new".into());
        }
        let identity = ProjectWorkOperationIdentity {
            kind: ProjectWorkOperationKind::MutationCall,
            id: "operation".into(),
            request_sha256: "a".repeat(64),
            mutation_call_id: Some("operation".into()),
        };
        let mut occurrence =
            occurrence::admit(&data, &scope, &identity, &updates, &collation).unwrap();
        if legacy {
            let attempt = occurrence.attempts.last_mut().unwrap();
            attempt.expected_base.schema = "butler.btcc-project-ledger-head.v1".into();
            attempt.expected_base =
                record::observe_expected(&scope.ledger_root, &attempt.expected_base).unwrap();
            let payload = serde_json::json!({
                "schema":"butler.btcc-project-ledger-effect-publication.v2",
                "occurrenceId":occurrence.occurrence_id,
                "attemptNumber":attempt.number,
                "requestSha256":attempt.request_sha256,
                "expectedBase":attempt.expected_base,
                "targetPreconditions":attempt.target_preconditions,
            });
            let encoded = butler_core::json::stringify(&payload).unwrap();
            attempt.publication_id = format!("{:x}", Sha256::digest(encoded.as_bytes()));
            let path = data
                .join("runtime/btcc-project-ledger-effects-v2/occurrences")
                .join(format!("{}.json", occurrence.occurrence_id));
            occurrence::atomic_json(&path, &occurrence).unwrap();
        }
        // Exercise the durable occurrence decoder as a restarted publisher does.
        let occurrence = occurrence::read(&data, &scope, &identity).unwrap().unwrap();
        Self {
            data,
            scope,
            collation,
            occurrence,
            updates,
        }
    }

    fn prepare(&self) -> (Journal, Paths) {
        let attempt = latest(&self.occurrence).unwrap();
        let paths = paths(&self.data, attempt);
        let journal = commit::prepare(
            &self.scope,
            &self.occurrence,
            attempt,
            &paths,
            &self.updates,
            &self.collation,
        )
        .unwrap();
        (journal, paths)
    }

    fn assert_visible(&self, expected: &str) {
        for path in ["plans/plan-a.md", "plans/plan-b.md"] {
            let raw =
                crate::project_ledger::committed::read_selected(&self.scope.ledger_root, path)
                    .unwrap()
                    .unwrap();
            assert_eq!(
                crate::project_ledger::records::frontmatter_body_ref(&raw).trim(),
                expected
            );
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.data);
    }
}

pub(in crate::project_ledger) fn interrupted_publications_recover_without_exposing_partial_records()
{
    cold_admission_schema_rolls_back_with_its_lock();
    uncommitted_candidates_are_discarded_and_drift_is_refused();
    addressed_heads_ignore_unrelated_works_but_legacy_heads_keep_their_digest();
    for legacy in [false, true] {
        for (status, promoted, advanced) in [
            (JournalStatus::Prepared, 0, false),
            (JournalStatus::Committing, 0, false),
            (JournalStatus::Committing, 1, false),
            (JournalStatus::Committing, 2, false),
            (JournalStatus::Committing, 2, true),
            (JournalStatus::Promoted, 2, true),
            (JournalStatus::Observed, 2, true),
        ] {
            let fixture = Fixture::new(legacy);
            let (mut journal, paths) = fixture.prepare();
            journal.status = status;
            occurrence::atomic_json(&paths.journal, &journal).unwrap();
            for path in ["plans/plan-a.md", "plans/plan-b.md"]
                .into_iter()
                .take(promoted)
            {
                fs::copy(
                    paths.candidate.join(path),
                    fixture.scope.ledger_root.join(path),
                )
                .unwrap();
            }
            if advanced {
                claim::advance_generation(
                    &claim::path(&fixture.scope.ledger_root),
                    &journal.publication_id,
                )
                .unwrap();
            }
            fixture.assert_visible("old");
            match reconcile(&fixture.data, &fixture.occurrence).unwrap() {
                Reconciled::Ready => {
                    apply(
                        &fixture.data,
                        &fixture.scope,
                        &fixture.occurrence,
                        None,
                        &fixture.collation,
                    )
                    .unwrap();
                }
                Reconciled::Applied(_) => {}
                _ => panic!("recoverable publication was discarded"),
            }
            fixture.assert_visible("new");
            assert!(matches!(
                reconcile(&fixture.data, &fixture.occurrence).unwrap(),
                Reconciled::Applied(_)
            ));
            assert!(!claim::path(&fixture.scope.ledger_root).exists());
            assert!(!paths.candidate.exists());
            assert!(!paths.candidate.with_extension("before").exists());
        }
    }
}

fn uncommitted_candidates_are_discarded_and_drift_is_refused() {
    for status in [JournalStatus::ClaimPending, JournalStatus::Preparing] {
        let fixture = Fixture::new(false);
        let (mut journal, paths) = fixture.prepare();
        journal.status = status;
        journal.candidate_head = None;
        occurrence::atomic_json(&paths.journal, &journal).unwrap();
        assert!(matches!(
            reconcile(&fixture.data, &fixture.occurrence).unwrap(),
            Reconciled::NotApplied
        ));
        fixture.assert_visible("old");
        assert!(!claim::path(&fixture.scope.ledger_root).exists());
    }
    let fixture = Fixture::new(false);
    let (_, paths) = fixture.prepare();
    fs::write(
        fixture.scope.ledger_root.join("plans/plan-a.md"),
        "external edit",
    )
    .unwrap();
    assert!(matches!(
        reconcile(&fixture.data, &fixture.occurrence).unwrap(),
        Reconciled::NotApplied
    ));
    assert!(!paths.candidate.exists());
}

fn addressed_heads_ignore_unrelated_works_but_legacy_heads_keep_their_digest() {
    let fixture = Fixture::new(false);
    let head = latest(&fixture.occurrence).unwrap().expected_base.clone();
    let mut legacy = head.clone();
    legacy.schema = "butler.btcc-project-ledger-head.v1".into();
    let legacy = record::observe_expected(&fixture.scope.ledger_root, &legacy).unwrap();
    fs::create_dir_all(fixture.scope.ledger_root.join("work/unrelated")).unwrap();
    assert_eq!(
        record::observe_expected(&fixture.scope.ledger_root, &head).unwrap(),
        head
    );
    assert_ne!(
        record::observe_expected(&fixture.scope.ledger_root, &legacy).unwrap(),
        legacy
    );
    crate::project_ledger::publication::with_mutation_claim(&fixture.scope.ledger_root, || {})
        .unwrap();
    assert_ne!(
        record::observe_expected(&fixture.scope.ledger_root, &head).unwrap(),
        head
    );
}

/// The mutex must serialize writers without committing non-authoritative SQL
/// state, and it must keep sharing the write reservation with legacy shards.
fn cold_admission_schema_rolls_back_with_its_lock() {
    let fixture = Fixture::new(false);
    let data = fixture.data.join("cold-admission");
    fs::create_dir_all(&data).unwrap();
    let result: Result<(), _> = occurrence::with_lock(&data, "operation", || {
        Err(ProjectWorkPublicationError::NotApplied)
    });
    assert!(matches!(
        result,
        Err(ProjectWorkPublicationError::NotApplied)
    ));
    occurrence::with_lock(&data, "operation", || Ok(())).unwrap();
    let shard = fs::read_dir(data.join("runtime/mutation-lock-shards"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.extension().and_then(|value| value.to_str()) == Some("sqlite3"))
        .unwrap();
    let mut legacy = butler_platform::sqlite::open(&shard).unwrap();
    let tables: i64 = legacy
        .query_row("SELECT COUNT(*) FROM sqlite_schema", [], |row| row.get(0))
        .unwrap();
    assert_eq!(tables, 0, "admission must not persist shadow state");
    legacy.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE shard_fence(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL);
        INSERT INTO shard_fence VALUES(1,7);
        CREATE TABLE active_lock(lock_key TEXT PRIMARY KEY,ownership_token TEXT NOT NULL,owner_id TEXT NOT NULL,acquired_at TEXT NOT NULL,renewed_at TEXT NOT NULL);").unwrap();
    let held = legacy
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let mut entered = false;
    let blocked = occurrence::with_lock(&data, "operation", || {
        entered = true;
        Ok(())
    });
    assert_eq!(
        blocked.unwrap_err().code(),
        "project_ledger_effect_occurrence_conflict"
    );
    assert!(!entered);
    held.rollback().unwrap();
    occurrence::with_lock(&data, "operation", || Ok(())).unwrap();
    let generation: i64 = legacy
        .query_row("SELECT generation FROM shard_fence", [], |row| row.get(0))
        .unwrap();
    let held: i64 = legacy
        .query_row("SELECT COUNT(*) FROM active_lock", [], |row| row.get(0))
        .unwrap();
    assert_eq!(generation, 7, "legacy shard state must remain intact");
    assert_eq!(held, 0);
}
