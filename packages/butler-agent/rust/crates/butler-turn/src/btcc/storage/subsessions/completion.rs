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
    ) -> Result<Vec<(String, String)>, StorageError> {
        self.storage
            .execute(move |db| commit(db, &completion, &now))
            .await
    }
}

fn commit(
    db: &mut rusqlite::Connection,
    completion: &ChildCompletion,
    now: &str,
) -> Result<Vec<(String, String)>, StorageError> {
    let tx = db.transaction().map_err(StorageError::sqlite)?;
    let result = turn_result_id(&completion.session, &completion.turn);
    let saved: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM btcc_steward_results WHERE result_id=?1)",
            [&result],
            |r| r.get(0),
        )
        .map_err(StorageError::sqlite)?;
    if saved {
        return Ok(Vec::new());
    }
    if !super::endings::accepts_completion(&tx, &completion.session, &completion.turn)? {
        return Ok(Vec::new());
    }
    let delegation = read(&tx, "r.child_session_id=?1", &completion.session)?.ok_or_else(|| {
        StorageError::new(
            StorageCode::SubsessionRelationMissing,
            "Subsession relation is missing",
        )
    })?;
    let mut completion = completion.clone();
    completion.summary = super::work_tasks::with_scope_errors(&tx, &completion.turn, completion.summary)?;
    let completion = &completion;
    let evidence = serde_json::to_string(&completion.evidence_refs)
        .map_err(|e| StorageError::new(StorageCode::SubsessionResultInvalid, e.to_string()))?;
    let code = result_code(completion);
    tx.execute("INSERT INTO btcc_steward_results (result_id,relation_id,task_id,child_session_id,child_turn_id,status,code,summary,acceptance_evidence_json,changed_artifacts_json,created_at) VALUES (?1,?2,?3,?4,?5,?6,?10,?7,?8,'[]',?9)",
        params![result,delegation.relation_id,delegation.task_id,completion.session,completion.turn,completion.status,completion.summary,evidence,now,code]).map_err(StorageError::sqlite)?;
    if delegation.packet.child_role == ChildRole::Steward {
        super::super::work::settle_steward_parent(
            &tx,
            &delegation,
            (&result, &completion.turn),
            &completion.status,
            &completion.summary,
            &completion.evidence_refs,
            now,
        )?;
    }
    let input = result_input(&tx, &delegation, completion, &result, now)?;
    let input = serde_json::to_string(&input)
        .map_err(|e| StorageError::new(StorageCode::SubsessionResultInvalid, e.to_string()))?;
    tx.execute("INSERT OR IGNORE INTO btcc_subsession_outbox (outbox_id,relation_id,result_id,parent_session_id,parent_turn_id,message_id,input_json,status,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8)",
        params![format!("outbox-{result}"),delegation.relation_id,result,delegation.parent_session_id,delegation.parent_turn_id,format!("subsession-result-message:{result}"),input,now]).map_err(StorageError::sqlite)?;
    super::directions::settle_continued_direction(
        &tx,
        &delegation.relation_id,
        &completion.turn,
        now,
    )?;
    if delegation.packet.child_role == ChildRole::Steward && completion.status == "cancelled" {
        super::directions::retire_with_stop(&tx, &delegation.relation_id, &completion.turn, now)?;
    }
    if delegation.packet.child_role == ChildRole::Worker {
        super::work_tasks::settle_dispatch(&tx, &delegation.relation_id, now)?;
    }
    let stopped =
        super::terminal::close_if_ended(&tx, &completion.session, &completion.status, now)?;
    tx.commit().map_err(StorageError::sqlite)?;
    Ok(stopped)
}

fn result_code(completion: &ChildCompletion) -> Option<&'static str> {
    completion
        .failure_code
        .as_ref()
        .map(|_| "steward_execution_failed")
        .or(completion
            .handoff
            .as_ref()
            .map(|_| "capability_unavailable_in_child"))
}

fn result_input(
    tx: &rusqlite::Transaction<'_>,
    delegation: &StoredSubsessionDelegation,
    completion: &ChildCompletion,
    result: &str,
    now: &str,
) -> Result<ParentResultInput, StorageError> {
    let packet = &delegation.packet;
    if packet.model_ref.is_empty() || packet.reasoning_effort.is_empty() {
        return Err(StorageError::new(
            StorageCode::SubsessionParentModelContextMissing,
            "Subsession model context is missing",
        ));
    }
    let text = result_text(tx, delegation, completion, result)?;
    Ok(match packet.child_role {
        ChildRole::Worker => ParentResultInput::StewardQueue(WorkerResultInput {
            text,
            model_ref: packet.model_ref.clone(),
            reasoning_effort: packet.reasoning_effort.clone(),
            timestamp: now.into(),
        }),
        ChildRole::Steward => ParentResultInput::ButlerApp(Box::new(StewardResultInput {
            child_session_id: Some(completion.session.clone()),
            relation_id: delegation.relation_id.clone(),
            result_id: result.into(),
            parent_session_id: delegation.parent_session_id.clone(),
            parent_turn_id: delegation.parent_turn_id.clone(),
            parent_chat_id: packet.parent_chat_id.clone().ok_or_else(|| {
                StorageError::new(
                    StorageCode::ParentAppBindingRequired,
                    "Parent App binding is missing",
                )
            })?,
            message_id: format!("subsession-result-message:{result}"),
            safe_title: result_title(&delegation.safe_title),
            text,
            model_ref: packet.model_ref.clone(),
            reasoning_effort: packet.reasoning_effort.clone(),
            access_mode: packet.access_mode.as_str().into(),
            timestamp: now.into(),
            schedule_run: super::instruction_context::current(
                tx,
                &completion.session,
                packet.schedule_run.clone(),
            )?,
        })),
    })
}

fn result_text(
    tx: &rusqlite::Transaction<'_>,
    delegation: &StoredSubsessionDelegation,
    completion: &ChildCompletion,
    result: &str,
) -> Result<String, StorageError> {
    let feedback =
        delegation_feedback(tx, delegation, result, completion.failure_reason.as_deref())?;
    let mut text = super::prompt_result::delivery_text(
        tx,
        result,
        &completion.status,
        &completion.summary,
        &completion.evidence_refs,
        &feedback,
    )?;
    text.push_str(&super::assets::delivery_assets(tx, &completion.turn)?);
    text.push_str(&delivery_artifacts(
        tx,
        &completion.turn,
        &completion.status,
    )?);
    if let Some(code) = completion
        .failure_code
        .as_deref()
        .or(result_code(completion))
    {
        text.push_str(&format!("\ncode: {code}"));
    }
    if let Some(handoff) = &completion.handoff {
        let encoded = serde_json::to_string(handoff)
            .map_err(|e| StorageError::new(StorageCode::SubsessionResultInvalid, e.to_string()))?;
        text.push_str(&format!("\ncapability_handoff: {encoded}\nContinue the requested action in this result Turn using your own granted tools and normal approval. Do not report this model/runtime-solvable issue to the user as an unfinished job. Reuse and revise the parent Plan to direct execution; the child is terminal."));
    }
    append_relay(
        &mut text,
        delegation.packet.child_role,
        &completion.status,
        completion.handoff.is_some(),
    );
    Ok(text)
}

impl SqliteSubsessionRepository {
    /// Marks a child result delivered and returns its changed execution link.
    pub async fn mark_delivered(
        &self,
        result: String,
        now: String,
    ) -> Result<Option<(String, String)>, StorageError> {
        self.storage
            .execute(move |db| {
                let tx = db.transaction().map_err(StorageError::sqlite)?;
                let link: Option<(String, String)> = tx.query_row(
                "SELECT r.parent_session_id,r.child_session_id FROM btcc_subsession_outbox o \
                 JOIN btcc_session_relations r ON r.relation_id=o.relation_id \
                 WHERE o.result_id=?1 AND o.status='pending'",
                [&result], |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional().map_err(StorageError::sqlite)?;
                tx.execute(
                    "UPDATE btcc_subsession_outbox SET status='delivered',delivered_at=?2 \
                WHERE result_id=?1 AND status='pending'",
                    params![result, now],
                )
                .map_err(StorageError::sqlite)?;
                let owns_ending: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM btcc_subsession_endings e JOIN btcc_steward_results x ON x.child_session_id=e.session_id AND x.child_turn_id=e.turn_id WHERE x.result_id=?1)", [&result], |r| r.get(0)).map_err(StorageError::sqlite)?;
                if let Some((_, child)) = &link && owns_ending {
                    tx.execute("DELETE FROM btcc_subsession_endings WHERE session_id=?1", [child]).map_err(StorageError::sqlite)?;
                    debug_assert!(terminal::invariant(&tx, child)?);
                }
                tx.commit().map_err(StorageError::sqlite)?;
                Ok(link)
            })
            .await
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
