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
    pub(crate) async fn has_turn_result(
        &self,
        session: String,
        turn: String,
    ) -> Result<bool, StorageError> {
        self.storage
            .work_model_read(move |db| {
                let id: Option<String> = db
                    .query_row(
                        crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_COMPLETION_1,
                        params![session, turn],
                        |r| r.get(0),
                    )
                    .optional()?;
                let result = id
                    .map(|id| format!("result-{id}"))
                    .unwrap_or_else(|| turn_result_id(&session, &turn));
                Ok(db
                    .query_row(
                        crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_COMPLETION_2,
                        [result],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some())
            })
            .await
    }
    pub(crate) async fn commit_result(
        &self,
        mut completion: ChildCompletion,
        now: String,
    ) -> Result<(), StorageError> {
        let child = self
            .by_child(completion.session.clone())
            .await?
            .ok_or_else(|| {
                StorageError::new(StorageCode::SubsessionRelationMissing, "Relation missing")
            })?;
        self.storage
            .work_model_write(move |tx| {
                let result_id = super::native_completion::settle(tx, &child, &completion)?;
                super::native_completion::resolve_outcome(tx, &child, &mut completion)?;
                if tx
                    .query_row(
                        crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_COMPLETION_3,
                        [&result_id],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some()
                {
                    return Ok(());
                }
                let text = result_text(tx, &child, &completion)?;
                let input = parent_input(&child, &result_id, text, &now);
                tx.execute(
                    crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_COMPLETION_4,
                    params![
                        format!("outbox-{result_id}"),
                        child.relation_id,
                        result_id,
                        child.parent_session_id,
                        child.parent_turn_id,
                        format!("subsession-result-message:{result_id}"),
                        serde_json::to_string(&input)?,
                        now
                    ],
                )?;
                tx.execute(
                    crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_COMPLETION_5,
                    [&child.relation_id],
                )?;
                Ok(())
            })
            .await
    }
}

fn parent_input(
    child: &crate::btcc::subsessions::assignment::Child,
    result_id: &str,
    text: String,
    now: &str,
) -> ParentResultInput {
    let packet = &child.packet;
    match packet.child_role {
        ChildRole::Worker if packet.parent_chat_id.is_none() => {
            ParentResultInput::StewardQueue(WorkerResultInput {
                text,
                model_ref: packet.model_ref.clone(),
                reasoning_effort: packet.reasoning_effort.clone(),
                timestamp: now.into(),
            })
        }
        _ => ParentResultInput::ButlerApp(Box::new(StewardResultInput {
            relation_id: child.relation_id.clone(),
            result_id: result_id.into(),
            parent_session_id: child.parent_session_id.clone(),
            parent_turn_id: child.parent_turn_id.clone(),
            parent_chat_id: packet.parent_chat_id.clone().unwrap_or_default(),
            message_id: format!("subsession-result-message:{result_id}"),
            safe_title: result_title(&child.safe_title),
            text,
            model_ref: packet.model_ref.clone(),
            reasoning_effort: packet.reasoning_effort.clone(),
            access_mode: packet.access_mode.clone(),
            timestamp: now.into(),
            schedule_run: packet.schedule_run.clone(),
        })),
    }
}

fn result_text(
    tx: &rusqlite::Transaction<'_>,
    child: &crate::btcc::subsessions::assignment::Child,
    completion: &ChildCompletion,
) -> butler_work::store::Result<String> {
    let evidence = serde_json::to_string(&completion.evidence_refs)?;
    let mut text = format!(
        "Delegated result\nstatus: {}\nsummary: {}\nevidence_refs: {evidence}",
        completion.status, completion.summary
    );
    if let Some(reason) = &completion.failure_reason {
        let count: i64 = tx.query_row(
            crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_COMPLETION_6,
            params![child.parent_session_id, child.packet.objective, reason],
            |r| r.get(0),
        )?;
        text.push_str(&format!("\nreason: {reason}"));
        if count > 1 {
            text.push_str(&format!(
                "\nThe same delegation failed for the same reason {count} times for this parent."
            ));
        }
        text.push_str("\nResolve this blocker or revise the Task/implementation approach before delegating again. Continue directly with your granted tools if possible; ask the user only for a decision or input they alone can supply.");
    }
    text.push_str(&super::assets::delivery_assets(tx, &completion.turn)?);
    text.push_str(&delivery_artifacts(
        tx,
        &completion.turn,
        &completion.status,
    )?);
    if let Some(code) = &completion.failure_code {
        text.push_str(&format!("\ncode: {code}"));
    }
    if let Some(handoff) = &completion.handoff {
        text.push_str(&format!(
            "\ncapability_handoff: {}",
            serde_json::to_string(handoff)?
        ));
    }
    append_relay(
        &mut text,
        child.packet.child_role,
        &completion.status,
        completion.handoff.is_some(),
    );
    Ok(text)
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
) -> butler_work::store::Result<String> {
    let raw: Option<String> = tx
        .query_row(
            crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_COMPLETION_7,
            [turn],
            |row| row.get(0),
        )
        .optional()?
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
