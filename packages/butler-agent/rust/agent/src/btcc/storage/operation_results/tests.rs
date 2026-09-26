use crate::json::JsonDocument;
use sha2::{Digest, Sha256};
use std::sync::Arc;

use super::*;
use crate::btcc::TurnStore;
use crate::btcc::storage::{
    BtccRepositories, StorageError, ToolJournalFinish, ToolJournalFinishStatus,
    ToolJournalRepository, ToolJournalStart, tests::Fixture,
};

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn golden() -> serde_json::Value {
    serde_json::from_str(include_str!("bun-golden.json")).expect("Bun golden")
}

struct Authority(ExactProjectWorkResultIdentity);

impl ExactProjectWorkResultAuthority for Authority {
    fn resolve(
        &self,
        input: &OperationResultReferenceInput,
    ) -> super::super::StorageResult<Option<ExactProjectWorkResultIdentity>> {
        Ok(
            (input.turn_id == self.0.turn_id && input.call_id == self.0.tool_call_id)
                .then(|| self.0.clone()),
        )
    }

    fn verify(
        &self,
        input: &ExactProjectWorkResultVerification,
    ) -> super::super::StorageResult<ExactProjectWorkResultIdentity> {
        let identity = &self.0;
        if input.result_ref == identity.result_ref
            && input.revision == identity.revision
            && input.work_id == identity.work_id
            && input.session_id == identity.session_id
            && input.scope_ref == identity.scope_ref
            && input.ledger_project_id == identity.ledger_project_id
            && input.tool_call_id == identity.tool_call_id
            && input.turn_id == identity.turn_id
            && input.result_sha256 == identity.result_sha256
        {
            Ok(identity.clone())
        } else {
            Err(StorageError::new(
                "operation_result_project_reference_mismatch",
                "operation_result_project_reference_mismatch",
            ))
        }
    }
}

async fn repository() -> (OperationResultRepository, BtccStorage, Fixture) {
    let fixture = Fixture::activated();
    let storage = BtccStorage::open(fixture.config("result-reader"))
        .await
        .unwrap();
    let repositories = BtccRepositories::new(storage.clone(), None);
    repositories
        .load_or_admit(&crate::btcc::storage::transition_tests::prepared())
        .await
        .unwrap();
    let journal = ToolJournalRepository::new(storage.clone(), Arc::new(|| "now".into()));
    journal
        .start(ToolJournalStart {
            turn_id: "turn".into(),
            call_id: "call".into(),
            tool_name: "read_file".into(),
            raw_arguments: "raw-한글".into(),
            arguments: serde_json::json!({"query":"Needle"}),
        })
        .await
        .unwrap();
    journal
        .finish(ToolJournalFinish {
            call_id: "call".into(),
            status: ToolJournalFinishStatus::Completed,
            result: Some(
                JsonDocument::from_value(&serde_json::json!({"ok":true,"text":"한글-result"}))
                    .unwrap(),
            ),
            changed_files: None,
            error_code: None,
        })
        .await
        .unwrap();
    storage
        .execute(|db| {
            db.execute(
                "INSERT INTO btcc_guided_tool_calls(call_id,turn_id,tool_name,raw_arguments,arguments_json,status,result_json,result_sha256,started_at)VALUES('failed','turn','shell','{}','{\"query\":\"needle\"}','completed','{\"ok\":false}',?1,'later')",
                [digest(r#"{"ok":false}"#)],
            )
            .map_err(StorageError::sqlite)?;
            db.execute(
                "INSERT INTO btcc_guided_tool_calls(call_id,turn_id,tool_name,raw_arguments,arguments_json,status,result_json,result_sha256,started_at)VALUES('reader','turn','read_operation_results','{}','{}','completed','{}',?1,'last')",
                [digest("{}")],
            )
            .map_err(StorageError::sqlite)?;
            Ok(())
        })
        .await
        .unwrap();
    (
        OperationResultRepository::new(storage.clone(), None),
        storage,
        fixture,
    )
}

async fn add_work(storage: &BtccStorage, kind: &str, ledger: Option<&str>, head: Option<&str>) {
    let kind = kind.to_owned();
    let ledger = ledger.map(str::to_owned);
    let head = head.map(str::to_owned);
    storage
        .execute(move |db| {
            db.execute(
                "INSERT INTO btcc_guided_works(work_id,session_id,scope_kind,scope_ref,ledger_project_id,canonical_head_sha256,origin_turn_id,origin_message_id,objective,status,created_at,updated_at)VALUES('work','session',?1,?2,?3,?4,'turn','message','objective','open','now','now')",
                rusqlite::params![kind, if kind == "session" { "session" } else { "project" }, ledger, head],
            )
            .map_err(StorageError::sqlite)?;
            db.execute(
                "INSERT INTO btcc_guided_work_results(result_ref,work_id,sequence,tool_call_id,origin_turn_id,attached_at)VALUES('ref','work',2,'call','turn','now')",
                [],
            )
            .map_err(StorageError::sqlite)?;
            Ok(())
        })
        .await
        .unwrap();
}

fn range_input(hash: String) -> ExactResultRangeInput {
    ExactResultRangeInput {
        turn_id: "turn".into(),
        result_ref: "ref".into(),
        result_sha256: hash,
        revision: Some(2.0),
        session_id: Some("session".into()),
        project_ref: None,
        work_id: Some("work".into()),
        offset: 0,
        length: 7,
        source: ExactResultSource::Request,
    }
}

#[tokio::test]
async fn discovery_matches_bun_pagination_outcomes_and_snapshot_through() {
    let (repository, storage, _fixture) = repository().await;
    let expected = golden();
    let page1 = repository
        .discover(OperationResultDiscoveryInput {
            turn_id: "turn".into(),
            work_id: None,
            cursor: 0.0,
            through: None,
            query: String::new(),
            tool_name: None,
            status: None,
            limit: 1.0,
        })
        .await
        .unwrap();
    assert_eq!(page1.through, expected["discovery"]["page1"]["through"]);
    assert_eq!(page1.next_cursor, Some(1.0));
    storage
        .execute(|db| {
            db.execute(
                "INSERT INTO btcc_guided_tool_calls(call_id,turn_id,tool_name,raw_arguments,arguments_json,status,result_json,result_sha256,started_at)VALUES('later','turn','write_file','{}','{}','completed','{}',?1,'later')",
                [digest("{}")],
            )
            .map_err(StorageError::sqlite)?;
            Ok(())
        })
        .await
        .unwrap();
    let page2 = repository
        .discover(OperationResultDiscoveryInput {
            turn_id: "turn".into(),
            work_id: None,
            cursor: page1.next_cursor.unwrap(),
            through: Some(page1.through),
            query: String::new(),
            tool_name: None,
            status: None,
            limit: 2.0,
        })
        .await
        .unwrap();
    assert_eq!(page2.entries.len(), 1);
    assert_eq!(page2.entries[0].call_id, "failed");
    assert_eq!(page2.next_cursor, None);
    let failed = repository
        .discover(OperationResultDiscoveryInput {
            turn_id: "turn".into(),
            work_id: None,
            cursor: 0.0,
            through: None,
            query: "NEEDLE".into(),
            tool_name: None,
            status: Some("failed".into()),
            limit: 10.0,
        })
        .await
        .unwrap();
    assert_eq!(failed.entries.len(), 1);
    assert_eq!(failed.entries[0].status, "failed");
    assert_eq!(
        failed.entries[0].result_sha256,
        expected["discovery"]["failed"]["entries"][0]["resultSha256"]
    );
    storage.close().await.unwrap();
}

#[tokio::test]
async fn direct_empty_project_ref_and_utf8_request_range_match_bun() {
    let (repository, storage, _fixture) = repository().await;
    let expected = golden();
    let reference = repository
        .resolve_result_reference(OperationResultReferenceInput {
            turn_id: "other".into(),
            call_id: "call".into(),
        })
        .await
        .unwrap();
    assert_eq!(reference.kind, "direct");
    let range = repository
        .read_exact_result_range(ExactResultRangeInput {
            turn_id: "turn".into(),
            result_ref: "call".into(),
            result_sha256: expected["hash"].as_str().unwrap().into(),
            revision: None,
            session_id: None,
            project_ref: Some(String::new()),
            work_id: None,
            offset: 0,
            length: 7,
            source: ExactResultSource::Request,
        })
        .await
        .unwrap();
    assert_eq!(range.data, expected["requestRange"]["data"]);
    assert_eq!(range.total_bytes, 10);
    assert_eq!(range.next_offset, Some(7));
    let error = repository
        .read_exact_result_range(ExactResultRangeInput {
            turn_id: "other".into(),
            result_ref: "call".into(),
            result_sha256: expected["hash"].as_str().unwrap().into(),
            revision: None,
            session_id: None,
            project_ref: None,
            work_id: None,
            offset: 0,
            length: 1,
            source: ExactResultSource::Result,
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, "operation_result_missing_or_scope_mismatch");
    storage.close().await.unwrap();
}

#[tokio::test]
async fn session_work_preserves_validation_order_and_exact_range_errors() {
    let (repository, storage, _fixture) = repository().await;
    add_work(&storage, "session", None, None).await;
    let reference = repository
        .resolve_result_reference(OperationResultReferenceInput {
            turn_id: "turn".into(),
            call_id: "call".into(),
        })
        .await
        .unwrap();
    assert_eq!(
        (reference.kind, reference.result_ref, reference.revision),
        ("work", "ref".into(), Some(2.0))
    );
    let hash = golden()["hash"].as_str().unwrap().to_owned();
    let mut input = range_input(hash.clone());
    input.revision = Some(1.0);
    input.work_id = Some("wrong".into());
    assert_code(&repository, input, "operation_result_revision_mismatch").await;
    let mut input = range_input(hash.clone());
    input.work_id = Some("wrong".into());
    assert_code(&repository, input, "operation_result_work_mismatch").await;
    let mut input = range_input(hash.clone());
    input.session_id = Some("wrong".into());
    assert_code(&repository, input, "operation_result_session_mismatch").await;
    let mut input = range_input(hash.clone());
    input.project_ref = Some("project".into());
    assert_code(&repository, input, "operation_result_scope_mismatch").await;
    let mut input = range_input("0".repeat(64));
    input.offset = usize::MAX;
    assert_code(&repository, input, "operation_result_integrity_mismatch").await;
    let mut input = range_input(hash);
    input.offset = usize::MAX;
    assert_code(&repository, input, "operation_result_range_out_of_bounds").await;
    storage.close().await.unwrap();
}

async fn assert_code(
    repository: &OperationResultRepository,
    input: ExactResultRangeInput,
    expected: &str,
) {
    assert_eq!(
        repository
            .read_exact_result_range(input)
            .await
            .unwrap_err()
            .code,
        expected
    );
}

#[tokio::test]
async fn body_hash_failure_precedes_supplied_hash_and_range_checks() {
    let (repository, storage, _fixture) = repository().await;
    storage
        .execute(|db| {
            db.execute(
                "UPDATE btcc_guided_tool_calls SET result_json='',result_sha256=?1 WHERE call_id='call'",
                [digest("")],
            )
            .map_err(StorageError::sqlite)?;
            Ok(())
        })
        .await
        .unwrap();
    let input = ExactResultRangeInput {
        turn_id: "turn".into(),
        result_ref: "call".into(),
        result_sha256: "wrong".into(),
        revision: None,
        session_id: None,
        project_ref: None,
        work_id: None,
        offset: usize::MAX,
        length: 1,
        source: ExactResultSource::Result,
    };
    assert_code(
        &repository,
        input,
        golden()["errors"]["emptyBody"].as_str().unwrap(),
    )
    .await;
    storage.close().await.unwrap();
}

#[tokio::test]
async fn managed_projection_requires_full_canonical_authority_match() {
    let (without_authority, storage, _fixture) = repository().await;
    add_work(
        &storage,
        "project",
        Some(" ledger "),
        Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    )
    .await;
    let input = OperationResultReferenceInput {
        turn_id: "turn".into(),
        call_id: "call".into(),
    };
    assert_eq!(
        without_authority
            .resolve_result_reference(input.clone())
            .await
            .unwrap_err()
            .code,
        golden()["errors"]["authorityMissing"]
    );
    let identity = ExactProjectWorkResultIdentity {
        result_ref: "ref".into(),
        revision: 2.0,
        work_id: "work".into(),
        session_id: "session".into(),
        scope_ref: "project".into(),
        ledger_project_id: " ledger ".into(),
        tool_call_id: "call".into(),
        tool_name: "read_file".into(),
        turn_id: "turn".into(),
        result_sha256: golden()["hash"].as_str().unwrap().into(),
    };
    let repository = OperationResultRepository::new(
        storage.clone(),
        Some(Arc::new(Authority(identity.clone()))),
    );
    let resolved = repository.resolve_result_reference(input).await.unwrap();
    assert_eq!(resolved.scope_kind.as_deref(), Some("project"));
    let range = repository
        .read_exact_result_range(ExactResultRangeInput {
            project_ref: Some("project".into()),
            ..range_input(identity.result_sha256.clone())
        })
        .await
        .unwrap();
    assert_eq!(range.data, golden()["requestRange"]["data"]);
    let direct = repository
        .read_exact_result_range(ExactResultRangeInput {
            turn_id: "turn".into(),
            result_ref: "call".into(),
            result_sha256: identity.result_sha256.clone(),
            revision: None,
            session_id: None,
            project_ref: Some(String::new()),
            work_id: None,
            offset: 0,
            length: 1,
            source: ExactResultSource::Result,
        })
        .await
        .unwrap();
    assert_eq!(direct.length, 1);
    let error = repository
        .read_exact_result_range(ExactResultRangeInput {
            turn_id: "turn".into(),
            result_ref: "call".into(),
            result_sha256: identity.result_sha256.clone(),
            revision: None,
            session_id: None,
            project_ref: Some("project".into()),
            work_id: None,
            offset: 0,
            length: 1,
            source: ExactResultSource::Result,
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, golden()["errors"]["projection"]);

    let mut mismatched = identity;
    mismatched.tool_name = "different_tool".into();
    let repository =
        OperationResultRepository::new(storage.clone(), Some(Arc::new(Authority(mismatched))));
    assert_eq!(
        repository
            .resolve_result_reference(OperationResultReferenceInput {
                turn_id: "turn".into(),
                call_id: "call".into(),
            })
            .await
            .unwrap_err()
            .code,
        "operation_result_project_reference_mismatch"
    );
    storage.close().await.unwrap();
}

#[tokio::test]
async fn repository_reopens_the_same_durable_result_without_owning_storage_close() {
    let (repository, storage, fixture) = repository().await;
    let hash = golden()["hash"].as_str().unwrap().to_owned();
    let first = repository
        .read_exact_result_range(ExactResultRangeInput {
            turn_id: "turn".into(),
            result_ref: "call".into(),
            result_sha256: hash.clone(),
            revision: None,
            session_id: None,
            project_ref: None,
            work_id: None,
            offset: 0,
            length: usize::MAX,
            source: ExactResultSource::Result,
        })
        .await
        .unwrap();
    storage.close().await.unwrap();
    let reopened = BtccStorage::open(fixture.config("result-reader-reopened"))
        .await
        .unwrap();
    let repository = OperationResultRepository::new(reopened.clone(), None);
    let second = repository
        .read_exact_result_range(ExactResultRangeInput {
            turn_id: "turn".into(),
            result_ref: "call".into(),
            result_sha256: hash,
            revision: None,
            session_id: None,
            project_ref: None,
            work_id: None,
            offset: 0,
            length: usize::MAX,
            source: ExactResultSource::Result,
        })
        .await
        .unwrap();
    assert_eq!(first, second);
    reopened.close().await.unwrap();
}
