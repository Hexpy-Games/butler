use super::*;
use rusqlite::params;

pub(crate) async fn stop_cancels_turn_claim_and_same_session_authority_atomically() {
    for suspended in [false, true] {
        let fixture = Fixture::activated();
        let storage = BtccStorage::open(fixture.config("repository-stop"))
            .await
            .expect("open repository storage");
        let repositories = BtccRepositories::new(storage, None);
        let (turn, _) = repositories
            .load_or_admit(&prepared("turn-stop", "trigger-stop", "hash-stop"))
            .await
            .expect("admit turn");
        let claim = repositories
            .acquire_state_claim(&turn)
            .await
            .expect("claim turn");
        repositories
        .storage
        .execute(move |db| {
            let continuation = crate::btcc::AuthorityLoopContinuation::fixture("ref-1", "call-1");
            db.execute("UPDATE btcc_turns SET authority_continuation_json=?1, suspension_reason=?2 WHERE turn_id='turn-stop'",
                params![serde_json::to_string(&continuation).unwrap(), suspended.then_some("authority_pending")])
                .map_err(StorageError::sqlite)?;
            db.execute(
                "INSERT INTO btcc_authority_requests (request_id,request_ref,identity_sha256,
            owner_session_id,source_session_id,source_turn_id,source_work_id,workspace_path,
            plan_revision_id,action_key,authority_generation,capability,normalized_target,
            normalized_input_json,model_ref,reasoning_effort,category,reason,executable,
            command_count,decision,allow_scope,schedule_client_message_id,schedule_input_text,
            outcome,created_at,updated_at) VALUES ('request-1','ref-1','identity-1','session-1',
            'session-1','turn-stop','work-1','/tmp','plan-1','action-1',1,'shell','target','{}',
            'openai/gpt','medium','command','reason','echo',1,'pending','once','schedule-1',
            'input','pending','now','now')",
                [],
            )
            .map_err(StorageError::sqlite)?;
            Ok(())
        })
        .await
        .expect("seed authority request");

        assert_eq!(
            repositories.stop("turn-stop").await.expect("stop turn"),
            StopPersistenceOutcome::Cancelled
        );
        let facts = repositories.storage.execute(move |db| {
        let state:String=db.query_row("SELECT semantic_state FROM btcc_turns WHERE turn_id='turn-stop'",[],|r|r.get(0)).map_err(StorageError::sqlite)?;
        let claim_status:String=db.query_row("SELECT status FROM btcc_state_claims WHERE claim_id=?1",[claim.claim_id],|r|r.get(0)).map_err(StorageError::sqlite)?;
        let authority:(Option<String>,Option<String>)=db.query_row("SELECT close_reason,close_scope FROM btcc_authority_requests WHERE request_id='request-1'",[],|r|Ok((r.get(0)?,r.get(1)?))).map_err(StorageError::sqlite)?;
        let continuation:Option<String>=db.query_row("SELECT authority_continuation_json FROM btcc_turns WHERE turn_id='turn-stop'",[],|r|r.get(0)).map_err(StorageError::sqlite)?;
        Ok((state,claim_status,authority,continuation))
    }).await.expect("inspect atomic stop");
        assert_eq!(facts.0, "cancelled");
        assert_eq!(facts.1, "revoked");
        assert_eq!(
            facts.2,
            (
                Some("session_cancelled".into()),
                Some("self_session".into())
            )
        );
        // Only a frozen batch may be replayed into cancelled tool rows. A running
        // resume can have already settled calls in its old continuation snapshot.
        assert_eq!(facts.3.is_some(), suspended);
        repositories.close().await.expect("close repository");
    }
}
