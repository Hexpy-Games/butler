//! Child result and parent feedback committed atomically.
use super::*;

impl SqliteSubsessionRepository {
    pub(crate) async fn commit_result(
        &self,
        completion: ChildCompletion,
        now: String,
    ) -> Result<(), StorageError> {
        let ChildCompletion {
            session: child_session,
            turn: child_turn,
            status,
            summary,
            failure_reason,
            failure_code,
            evidence_refs,
            handoff,
        } = completion;
        self.storage.execute(move |db| {
            let delegation = read(db,"r.child_session_id=?1",&child_session)?.ok_or_else(|| StorageError::new(StorageCode::SubsessionRelationMissing,"Subsession relation is missing"))?;
            let result_id = format!("result-{}", crate::btcc::digest_identity(&format!("btcc.subsession.result.v1\0{child_session}\0{child_turn}")));
            let packet = &delegation.packet;
            let model = packet.model_ref.as_str();
            let reasoning = packet.reasoning_effort.as_str();
            let access = required_packet_string(&packet.access_mode, "access_mode")?;
            let parent_chat = packet.parent_chat_id.as_deref();
            if model.is_empty() || reasoning.is_empty() { return Err(StorageError::new(StorageCode::SubsessionParentModelContextMissing,"Subsession model context is missing")); }
            let tx = db.transaction().map_err(StorageError::sqlite)?;
            let evidence_json=serde_json::to_string(&evidence_refs).map_err(|e| StorageError::new(StorageCode::SubsessionResultInvalid,e.to_string()).with_source(e))?;
            let code = failure_code.as_ref().map(|_| "steward_execution_failed")
                .or(handoff.as_ref().map(|_| "capability_unavailable_in_child"));
            tx.execute("INSERT OR IGNORE INTO btcc_steward_results (result_id,relation_id,task_id,child_session_id,child_turn_id,status,code,summary,acceptance_evidence_json,changed_artifacts_json,created_at) VALUES (?1,?2,?3,?4,?5,?6,?10,?7,?8,'[]',?9)",params![result_id,delegation.relation_id,delegation.task_id,child_session,child_turn,status,summary,evidence_json,now,code]).map_err(StorageError::sqlite)?;
            let feedback = delegation_feedback(&tx, &delegation, &result_id, failure_reason.as_deref())?;
            let mut text = format!("Delegated result\nstatus: {status}\nsummary: {summary}\nevidence_refs: {evidence_json}{feedback}");
            if let Some(code) = failure_code.as_deref().or(code) { text.push_str(&format!("\ncode: {code}")); }
            if let Some(handoff) = handoff {
                let encoded = serde_json::to_string(&handoff).map_err(|e| StorageError::new(StorageCode::SubsessionResultInvalid,e.to_string()).with_source(e))?;
                text.push_str(&format!("\ncapability_handoff: {encoded}\nContinue the requested action in this result Turn using your own granted tools and normal approval. Do not report this model/runtime-solvable issue to the user as an unfinished job. Reuse and revise the parent Plan to direct execution; the child is terminal."));
            }
            let input = match packet.child_role {
                ChildRole::Worker => ParentResultInput::StewardQueue(WorkerResultInput {
                    text: text.clone(), model_ref: model.into(),
                    reasoning_effort: reasoning.into(), timestamp: now.clone(),
                }),
                ChildRole::Steward => ParentResultInput::ButlerApp(StewardResultInput {
                    relation_id: delegation.relation_id.clone(),
                    result_id: result_id.clone(),
                    parent_session_id: delegation.parent_session_id.clone(),
                    parent_turn_id: delegation.parent_turn_id.clone(),
                    parent_chat_id: parent_chat.ok_or_else(|| StorageError::new(StorageCode::ParentAppBindingRequired,"Parent App binding is missing"))?.into(),
                    message_id: format!("subsession-result-message:{result_id}"),
                    safe_title: "Delegated result".into(), text: text.clone(), model_ref: model.into(),
                    reasoning_effort: reasoning.into(), access_mode: access.into(), timestamp: now.clone(),
                }),
            };
            let input = serde_json::to_string(&input).map_err(|e| StorageError::new(StorageCode::SubsessionResultInvalid,e.to_string()).with_source(e))?;
            tx.execute("INSERT OR IGNORE INTO btcc_subsession_outbox (outbox_id,relation_id,result_id,parent_session_id,parent_turn_id,message_id,input_json,status,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8)",params![format!("outbox-{result_id}"),delegation.relation_id,result_id,delegation.parent_session_id,delegation.parent_turn_id,format!("subsession-result-message:{result_id}"),input,now]).map_err(StorageError::sqlite)?;
            tx.commit().map_err(StorageError::sqlite)?;
            Ok(())
        }).await
    }
}

fn delegation_feedback(
    tx: &rusqlite::Transaction<'_>,
    delegation: &StoredSubsessionDelegation,
    result_id: &str,
    reason: Option<&str>,
) -> Result<String, StorageError> {
    let Some(reason) = reason else {
        return Ok(String::new());
    };
    let packet = &delegation.packet;
    let identity = serde_json::json!([
        packet.child_role,
        packet.objective,
        packet.plan_action.as_ref().map(|action| &action.action_key)
    ]);
    let key = crate::btcc::digest_identity(&format!(
        "{}\0{identity}\0{reason}",
        delegation.parent_session_id
    ));
    tx.execute(
        "UPDATE btcc_steward_results SET failure_key=?2 WHERE result_id=?1 AND failure_key IS NULL",
        params![result_id, key],
    )
    .map_err(StorageError::sqlite)?;
    let count: u64 = tx
        .query_row(
            "SELECT count(*) FROM btcc_steward_results WHERE failure_key=?1",
            params![key],
            |row| row.get(0),
        )
        .map_err(StorageError::sqlite)?;
    let repeated = if count > 1 {
        format!("\nThe same delegation failed for the same reason {count} times for this parent.")
    } else {
        String::new()
    };
    Ok(format!(
        "\nreason: {reason}{repeated}\nResolve this blocker or revise the Plan/implementation approach before delegating again. Continue directly with your granted tools if possible; ask the user only for a decision or input they alone can supply."
    ))
}
