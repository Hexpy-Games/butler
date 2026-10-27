//! Child result and parent feedback committed atomically.
use super::*;

/// A successful Steward result is relayed as the answer: open items are work
/// to settle, not caveats to forward.
const RELAY: &str = "\nDeliver this to the user as your answer, outcome first. Its open or unconfirmed items are work, not caveats: settle any that one quick lookup can settle, and keep only what still matters to the user's next decision, once, in one line. Never forward a limitations list, per-item unconfirmed tags or columns, lines about what was not re-checked or what the result does not prove or guarantee, or how the work was recorded.";

/// The result identity of one child turn: each turn has at most one result.
pub fn turn_result_id(session: &str, turn: &str) -> String {
    format!(
        "result-{}",
        crate::btcc::digest_identity(&format!("btcc.subsession.result.v1\0{session}\0{turn}"))
    )
}

impl SqliteSubsessionRepository {
    /// Whether the child turn's result is saved (a primary-key lookup).
    pub(crate) async fn has_turn_result(
        &self,
        session: String,
        turn: String,
    ) -> Result<bool, StorageError> {
        let id = turn_result_id(&session, &turn);
        self.storage
            .execute(move |db| {
                db.query_row(
                    "SELECT 1 FROM btcc_steward_results WHERE result_id=?1",
                    [id],
                    |_| Ok(()),
                )
                .optional()
                .map(|row| row.is_some())
                .map_err(StorageError::sqlite)
            })
            .await
    }

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
            let result_id = turn_result_id(&child_session, &child_turn);
            let packet = &delegation.packet;
            let model = packet.model_ref.as_str();
            let reasoning = packet.reasoning_effort.as_str();
            let access = packet.access_mode.as_str();
            let parent_chat = packet.parent_chat_id.as_deref();
            if model.is_empty() || reasoning.is_empty() { return Err(StorageError::new(StorageCode::SubsessionParentModelContextMissing,"Subsession model context is missing")); }
            let tx = db.transaction().map_err(StorageError::sqlite)?;
            let evidence_json=serde_json::to_string(&evidence_refs).map_err(|e| StorageError::new(StorageCode::SubsessionResultInvalid,e.to_string()).with_source(e))?;
            let code = failure_code.as_ref().map(|_| "steward_execution_failed")
                .or(handoff.as_ref().map(|_| "capability_unavailable_in_child"));
            let inserted = tx.execute("INSERT OR IGNORE INTO btcc_steward_results (result_id,relation_id,task_id,child_session_id,child_turn_id,status,code,summary,acceptance_evidence_json,changed_artifacts_json,created_at) VALUES (?1,?2,?3,?4,?5,?6,?10,?7,?8,'[]',?9)",params![result_id,delegation.relation_id,delegation.task_id,child_session,child_turn,status,summary,evidence_json,now,code]).map_err(StorageError::sqlite)?;
            // One result per child turn: closing a turn whose result is already
            // saved (a restart after a crash between commit and queue settlement)
            // changes nothing, so a success is never re-keyed or delivered twice.
            if inserted == 0 {
                return Ok(());
            }
            if packet.child_role == ChildRole::Steward {
                super::super::work::settle_steward_parent(&tx, &delegation, (&result_id, &child_turn), &status, &summary, &evidence_refs, &now)?;
            }
            let feedback = delegation_feedback(&tx, &delegation, &result_id, failure_reason.as_deref())?;
            let mut text = format!("Delegated result\nstatus: {status}\nsummary: {summary}\nevidence_refs: {evidence_json}{feedback}");
            text.push_str(&super::assets::delivery_assets(&tx, &child_turn)?);
            text.push_str(&delivery_artifacts(&tx, &child_turn, &status)?);
            if let Some(code) = failure_code.as_deref().or(code) { text.push_str(&format!("\ncode: {code}")); }
            let has_handoff = handoff.is_some();
            if let Some(handoff) = handoff {
                let encoded = serde_json::to_string(&handoff).map_err(|e| StorageError::new(StorageCode::SubsessionResultInvalid,e.to_string()).with_source(e))?;
                text.push_str(&format!("\ncapability_handoff: {encoded}\nContinue the requested action in this result Turn using your own granted tools and normal approval. Do not report this model/runtime-solvable issue to the user as an unfinished job. Reuse and revise the parent Plan to direct execution; the child is terminal."));
            }
            append_relay(&mut text, packet.child_role, &status, has_handoff);
            let input = match packet.child_role {
                ChildRole::Worker => ParentResultInput::StewardQueue(WorkerResultInput {
                    text: text.clone(), model_ref: model.into(),
                    reasoning_effort: reasoning.into(), timestamp: now.clone(),
                }),
                ChildRole::Steward => ParentResultInput::ButlerApp(Box::new(StewardResultInput {
                    child_session_id: Some(child_session.clone()),
                    relation_id: delegation.relation_id.clone(),
                    result_id: result_id.clone(),
                    parent_session_id: delegation.parent_session_id.clone(),
                    parent_turn_id: delegation.parent_turn_id.clone(),
                    parent_chat_id: parent_chat.ok_or_else(|| StorageError::new(StorageCode::ParentAppBindingRequired,"Parent App binding is missing"))?.into(),
                    message_id: format!("subsession-result-message:{result_id}"),
                    safe_title: result_title(&delegation.safe_title), text: text.clone(), model_ref: model.into(),
                    reasoning_effort: reasoning.into(), access_mode: access.into(), timestamp: now.clone(),
                    schedule_run: super::instruction_context::current(&tx, &child_session, packet.schedule_run.clone())?,
                })),
            };
            let input = serde_json::to_string(&input).map_err(|e| StorageError::new(StorageCode::SubsessionResultInvalid,e.to_string()).with_source(e))?;
            tx.execute("INSERT OR IGNORE INTO btcc_subsession_outbox (outbox_id,relation_id,result_id,parent_session_id,parent_turn_id,message_id,input_json,status,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8)",params![format!("outbox-{result_id}"),delegation.relation_id,result_id,delegation.parent_session_id,delegation.parent_turn_id,format!("subsession-result-message:{result_id}"),input,now]).map_err(StorageError::sqlite)?;
            super::directions::settle_continued_direction(&tx, &delegation.relation_id, &child_turn, &now)?;
            if packet.child_role == ChildRole::Worker {
                tx.execute(super::worker_admission::COMPLETE_WORKER_SQL, params![delegation.relation_id]).map_err(StorageError::sqlite)?;
            }
            tx.commit().map_err(StorageError::sqlite)?;
            Ok(())
        }).await
    }
}

/// The result Turn is titled after the delegated work it reports, the same
/// title the App shows for that work.
fn result_title(relation_title: &str) -> String {
    match relation_title.trim() {
        "" => "Delegated result".into(),
        title => title.into(),
    }
}

fn delivery_artifacts(
    tx: &rusqlite::Transaction<'_>,
    turn: &str,
    status: &str,
) -> Result<String, StorageError> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT final_payload_json FROM btcc_turns WHERE turn_id=?1",
            [turn],
            |row| row.get(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .flatten();
    let Some(payload) = raw.and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    else {
        return Ok(String::new());
    };
    let mut result = serde_json::json!({"child_turn_id":turn,"status":status});
    super::super::subsession_result::project_delivery(&mut result, &payload);
    let Some(artifacts) = result
        .get("artifacts")
        .filter(|value| value.as_array().is_some_and(|items| !items.is_empty()))
    else {
        return Ok(String::new());
    };
    Ok(format!(
        "\nartifacts: {artifacts}\nThese captured files accompany this result and are attached to your reply automatically. For image artifacts, display them inline with Markdown ![caption](exact safePathLabel). Use each exact safePathLabel when linking other artifacts."
    ))
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

fn append_relay(text: &mut String, role: ChildRole, status: &str, has_handoff: bool) {
    if role == ChildRole::Steward && status == "success" && !has_handoff {
        text.push_str(RELAY);
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    pub(in crate::btcc::storage::subsessions) fn assert_success_relay_format() {
        let expected_relay = "\nDeliver this to the user as your answer, outcome first. Its open or unconfirmed items are work, not caveats: settle any that one quick lookup can settle, and keep only what still matters to the user's next decision, once, in one line. Never forward a limitations list, per-item unconfirmed tags or columns, lines about what was not re-checked or what the result does not prove or guarantee, or how the work was recorded.";
        for (role, status, handback, expected) in [
            (ChildRole::Steward, "success", false, true),
            (ChildRole::Steward, "blocked", false, false),
            (ChildRole::Steward, "failed", false, false),
            (ChildRole::Steward, "cancelled", false, false),
            (ChildRole::Steward, "success", true, false),
            (ChildRole::Worker, "success", false, false),
        ] {
            let mut text = String::from("Delegated result");
            append_relay(&mut text, role, status, handback);
            let expected_text = if expected {
                format!("Delegated result{expected_relay}")
            } else {
                "Delegated result".to_owned()
            };
            assert_eq!(text, expected_text);
        }
    }
}
