use super::*;

impl SqliteSubsessionRepository {
    pub(crate) async fn prompt_result_for_relation(
        &self,
        relation: String,
    ) -> Result<Option<Value>, StorageError> {
        let Some(mut result) = self.result_for_relation(relation).await? else {
            return Ok(None);
        };
        let id = result
            .get("result_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let summary = result
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let refs: Vec<String> = serde_json::from_value(
            result
                .get("acceptance_evidence")
                .cloned()
                .unwrap_or(Value::Null),
        )
        .map_err(|e| StorageError::new(StorageCode::SubsessionResultInvalid, e.to_string()))?;
        let manifest = self
            .storage
            .execute(move |db| {
                super::super::operation_results::evidence::manifest(db, &id, &refs, &summary)
            })
            .await?;
        if let Some(object) = result.as_object_mut() {
            object.remove("acceptance_evidence");
            object.insert("evidence".into(), manifest.into());
        }
        Ok(Some(result))
    }
}

pub(super) fn delivery_text(
    db: &rusqlite::Connection,
    id: &str,
    status: &str,
    summary: &str,
    refs: &[String],
    feedback: &str,
    delegation: &StoredSubsessionDelegation,
) -> Result<String, StorageError> {
    let evidence = super::super::operation_results::evidence::manifest(db, id, refs, summary)?;
    let (task, earlier) = worker_task_lines(db, delegation)?;
    Ok(format!(
        "Delegated result\nresult_id: {id}{task}\nstatus: {status}\nsummary: {summary}\n{evidence}{feedback}{earlier}"
    ))
}

fn worker_task_lines(
    db: &rusqlite::Connection,
    delegation: &StoredSubsessionDelegation,
) -> Result<(String, String), StorageError> {
    if delegation.packet.child_role != ChildRole::Worker {
        return Ok((String::new(), String::new()));
    }
    let work: Option<String> = db
        .query_row(
            "SELECT work_id FROM btcc_work_tasks WHERE relation_id=?1",
            [&delegation.relation_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    let Some(work) = work else {
        return Ok((String::new(), String::new()));
    };
    let tasks = super::work_tasks::read_tasks(db, &work)?;
    let Some(task) = tasks
        .iter()
        .find(|task| task.relation_id == delegation.relation_id)
    else {
        return Ok((String::new(), String::new()));
    };
    let running = tasks
        .iter()
        .filter(|task| {
            task.relation_id != delegation.relation_id
                && matches!(task.status.as_str(), "pending" | "active")
        })
        .map(|task| format!("{} {} ({})", task.task_id, task.action_key, task.status))
        .collect::<Vec<_>>();
    let running = if running.is_empty() {
        "none".into()
    } else {
        running.join("; ")
    };
    let objective = delegation
        .packet
        .objective
        .chars()
        .take(200)
        .collect::<String>();
    let lines = format!(
        "\ntask: {} action_key: {} relation_id: {} objective: {objective}\nstill running: {running}",
        task.task_id, task.action_key, task.relation_id
    );
    Ok((lines, earlier_results(&tasks, &delegation.relation_id)))
}

fn earlier_results(tasks: &[crate::btcc::WorkTask], relation: &str) -> String {
    let lines: String = tasks
        .iter()
        .filter(|task| {
            task.relation_id != relation && matches!(task.status.as_str(), "done" | "cancelled")
        })
        .filter_map(|task| {
            Some(format!(
                "\n- result_id: {} task: {} action_key: {} ({})\n  summary: {}",
                task.result_ref.as_deref()?,
                task.task_id,
                task.action_key,
                task.status,
                task.summary.as_deref().unwrap_or("")
            ))
        })
        .collect();
    if lines.is_empty() {
        return lines;
    }
    format!("\nEarlier Worker results in this Work (delivered to earlier turns):{lines}")
}
