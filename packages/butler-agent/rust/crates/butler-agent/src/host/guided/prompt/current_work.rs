use super::*;
pub(super) async fn work_stream(
    state: &GuidedTextState,
    turn: &TurnRecord,
) -> Result<String, BtccError> {
    let work_stream = if let Some(model) = state.work_service.work_model() {
        let summary = model.summary(turn.session_id.clone(), None).await?;
        if summary["tier"] == 0 {
            String::new()
        } else {
            let node = summary["current_task"]["spec_ref"]["node_id"]
                .as_str()
                .or_else(|| {
                    (summary["tier"] == 1)
                        .then(|| summary["root_node_id"].as_str())
                        .flatten()
                });
            let spec = match node {
                Some(node) => {
                    model
                        .read_spec(turn.session_id.clone(), node.into())
                        .await?
                }
                None => Value::Null,
            };
            format!(
                "Canonical current Work model (remaining pages via work_read):\n{}\nExact responsible Spec and inherited criteria:\n{}",
                json(&summary)?,
                json(&spec)?
            )
        }
    } else if state.phase.execution_policy.tracking_mode == "none" {
        String::new()
    } else {
        let mut projection = state
            .work_streams
            .prompt_context(
                turn.session_id.clone(),
                state.phase.execution_policy.project_id.clone(),
            )
            .await?;
        let workers = state
            .subsessions
            .worker_prompt_lines(turn.session_id.clone(), projection.worker_task_ids)
            .await?;
        if !workers.is_empty() {
            projection.text.push_str("\nLinked Workers:\n");
            projection.text.push_str(&workers.join("\n"));
        }
        projection.text
    };
    Ok(work_stream)
}
