use rusqlite::params;

use crate::btcc::storage::StorageError;
use crate::btcc::work::{StartWorkInput, WorkStatus};

use super::tests::{opened, scope};

#[tokio::test]
async fn open_legacy_session_program_imports_once_and_preserves_original_turn() {
    let (_fixture, storage, service, _journal) = opened("work-legacy-import").await;
    storage
        .execute(|db| {
            // The old tables are fixture input: the new Work writer remains the sole producer.
            db.execute_batch(
                "ALTER TABLE btcc_turns ADD COLUMN goal_contract_ref TEXT; \
                 ALTER TABLE btcc_turns ADD COLUMN managed_state_json TEXT; \
                 CREATE TABLE btcc_programs (program_id TEXT PRIMARY KEY, session_id TEXT, \
                 scope_kind TEXT, scope_id TEXT, frontier TEXT, goal_contract_ref TEXT, \
                 accepted_plan_ref TEXT, manifest_revision INTEGER); \
                 CREATE TABLE btcc_work_items (work_id TEXT, program_id TEXT, work_ref TEXT, \
                 status TEXT, is_active INTEGER); \
                 CREATE TABLE btcc_tasks (task_id TEXT, program_id TEXT, task_ref TEXT, \
                 status TEXT, is_active INTEGER); \
                 CREATE TABLE btcc_ledger_mutations (program_id TEXT);",
            )
            .map_err(StorageError::sqlite)?;
            db.execute("INSERT INTO btcc_records (record_id,kind,sha256,content_json) \
                VALUES ('goal','goal','hash','{\"request\":\"Finish legacy request\",\"originalMessageId\":\"message\"}')", [])
                .map_err(StorageError::sqlite)?;
            db.execute("INSERT INTO btcc_programs VALUES \
                ('legacy','session','session','session','active','goal',NULL,3)", [])
                .map_err(StorageError::sqlite)?;
            Ok(())
        })
        .await
        .unwrap();
    let imported = service
        .import_open_legacy_work(scope())
        .await
        .unwrap()
        .unwrap();
    assert!(imported.imported);
    assert_eq!(imported.source_program_id, "legacy");
    assert_eq!(imported.work.objective, "Finish legacy request");
    assert_eq!(imported.work.origin.turn_id, "turn");
    let replay = service
        .import_open_legacy_work(scope())
        .await
        .unwrap()
        .unwrap();
    assert!(!replay.imported);
    assert_eq!(replay.work.work_id, imported.work.work_id);
    assert_eq!(
        service
            .bind_open_work(scope(), None)
            .await
            .unwrap()
            .unwrap()
            .work_id,
        imported.work.work_id
    );
    storage.close().await.unwrap();
}

#[tokio::test]
async fn abandonment_and_exact_authority_close_roll_back_together() {
    let (_fixture, storage, service, _journal) = opened("work-authority-rollback").await;
    let work = service
        .start_work(StartWorkInput {
            scope: scope(),
            mutation_call_id: "start-authority".into(),
            objective: "needs authority".into(),
            backfill_tool_call_ids: None,
        })
        .await
        .unwrap();
    let work_id = work.work_id.clone();
    storage.execute(move |db| {
        for (request_id, source_work_id) in [("match", work_id.as_str()), ("other", "other-work")] {
            db.execute("INSERT INTO btcc_authority_requests
                (request_id,request_ref,identity_sha256,owner_session_id,source_session_id,source_turn_id,
                source_work_id,workspace_path,plan_revision_id,action_key,authority_generation,capability,
                normalized_target,normalized_input_json,model_ref,reasoning_effort,category,reason,executable,
                command_count,decision,allow_scope,schedule_client_message_id,schedule_input_text,outcome,
                created_at,updated_at) VALUES (?1,?1,?1,'session','session','turn',?2,'/tmp','plan','action',1,
                'shell','target','{}','openai/gpt','medium','command','reason','echo',1,'pending','once',
                ?1 || '-message','input','pending','now','now')", params![request_id, source_work_id])
                .map_err(StorageError::sqlite)?;
        }
        db.execute_batch("CREATE TRIGGER fail_authority_close BEFORE UPDATE ON btcc_authority_requests
            WHEN NEW.close_reason = 'work_abandoned' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;")
            .map_err(StorageError::sqlite)?;
        Ok(())
    }).await.unwrap();
    assert!(
        service
            .abandon_bound_work_for_turn("turn".into())
            .await
            .is_err()
    );
    assert_eq!(
        service
            .bound_work_for_turn("turn".into())
            .await
            .unwrap()
            .unwrap()
            .status,
        WorkStatus::Open
    );
    storage
        .execute(|db| {
            db.execute_batch("DROP TRIGGER fail_authority_close")
                .map_err(StorageError::sqlite)?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        service
            .abandon_bound_work_for_turn("turn".into())
            .await
            .unwrap()
            .unwrap()
            .status,
        WorkStatus::Abandoned
    );
    let reasons: Vec<(String, Option<String>)> = storage.execute(|db| {
        let mut statement = db.prepare("SELECT request_id, close_reason FROM btcc_authority_requests ORDER BY request_id")
            .map_err(StorageError::sqlite)?;
        statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(StorageError::sqlite)?
            .collect::<Result<Vec<_>, _>>().map_err(StorageError::sqlite)
    }).await.unwrap();
    assert_eq!(
        reasons,
        vec![
            ("match".into(), Some("work_abandoned".into())),
            ("other".into(), None)
        ]
    );
    storage.close().await.unwrap();
}
