use serde_json::json;

use super::repository::BtccRepositories;
use super::testing::{Fixture, prepared};
use super::*;
use crate::btcc::{SuspensionReason, TurnStore, TurnTransition};

#[tokio::test]
async fn authority_suspension_rolls_back_then_resumes_from_decision() {
    let fixture = Fixture::activated();
    let storage = BtccStorage::open(fixture.config("repository-authority"))
        .await
        .expect("open storage");
    let repositories = BtccRepositories::new(storage, None);
    let (turn, _) = repositories
        .load_or_admit(&prepared())
        .await
        .expect("admit turn");
    let claim = repositories
        .acquire_state_claim(&turn)
        .await
        .expect("claim turn");
    repositories.storage.execute(|db| { db.execute("INSERT INTO btcc_authority_requests
        (request_id,request_ref,identity_sha256,owner_session_id,source_session_id,source_turn_id,
        source_work_id,workspace_path,plan_revision_id,action_key,authority_generation,capability,
        normalized_target,normalized_input_json,model_ref,reasoning_effort,category,reason,executable,
        command_count,decision,allow_scope,schedule_client_message_id,schedule_input_text,outcome,
        created_at,updated_at) VALUES ('request','authority-ref','identity','session','session','turn',
        'work','/tmp','plan','action',1,'shell','target','{}','openai/gpt','medium','command','reason',
        'echo',1,'pending','once','client-message','input','pending','now','now')",[])
        .map_err(StorageError::sqlite)?; Ok(()) }).await.expect("seed authority");
    let transition = TurnTransition::Suspend {
        reason: SuspensionReason::AuthorityPending,
        authority_continuation: Some(json!({"requestRef":"authority-ref","callId":"call-1"})),
    };
    let first = repositories
        .commit_transition(&turn, &claim, &transition)
        .await
        .expect_err("missing call rolls back");
    assert!(matches!(
        first,
        crate::btcc::TransitionCommitError::Failure(_)
    ));
    let rolled_back = repositories
        .storage
        .execute({
            let claim_id = claim.claim_id.clone();
            move |db| {
                let claim_status: String = db
                    .query_row(
                        "SELECT status FROM btcc_state_claims WHERE claim_id=?1",
                        [claim_id],
                        |r| r.get(0),
                    )
                    .map_err(StorageError::sqlite)?;
                let source: Option<String> = db
                    .query_row(
                        "SELECT source_call_id FROM btcc_authority_requests
            WHERE request_ref='authority-ref'",
                        [],
                        |r| r.get(0),
                    )
                    .map_err(StorageError::sqlite)?;
                Ok((claim_status, source))
            }
        })
        .await
        .expect("inspect rollback");
    assert_eq!(rolled_back, ("active".into(), None));
    repositories
        .storage
        .execute(|db| {
            db.execute(
                "INSERT INTO btcc_guided_tool_calls
        (call_id,turn_id,tool_name,raw_arguments,arguments_json,status,started_at)
        VALUES ('call-1','turn','shell','{}','{}','started','now')",
                [],
            )
            .map_err(StorageError::sqlite)?;
            Ok(())
        })
        .await
        .expect("seed tool call");
    repositories
        .commit_transition(&turn, &claim, &transition)
        .await
        .expect("suspend turn");
    let suspended = repositories
        .activate_successor("turn")
        .await
        .expect("load suspension");
    assert_eq!(
        suspended.suspension,
        Some(SuspensionReason::AuthorityPending)
    );
    repositories
        .storage
        .execute(|db| {
            db.execute(
                "UPDATE btcc_authority_requests SET decision='allowed'
        WHERE request_ref='authority-ref'",
                [],
            )
            .map_err(StorageError::sqlite)?;
            Ok(())
        })
        .await
        .expect("allow authority");
    let resumed = repositories
        .resume_authority("turn")
        .await
        .expect("resume query")
        .expect("resumed");
    assert_eq!(resumed.suspension, None);
    assert_eq!(resumed.context["authorityRequestRef"], "authority-ref");
    assert_eq!(
        resumed.context["authorityClientMessageId"],
        "client-message"
    );
    assert!(resumed.checkpoint.is_some());
    repositories.close().await.expect("close repository");
}
