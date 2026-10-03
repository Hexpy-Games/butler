use super::*;

impl WorkModelRepository {
    pub async fn effect_grant(
        &self,
        session: String,
        turn: String,
    ) -> Result<WorkModelEffectGrant> {
        let repository = self.clone();
        self.lane(move |db| {
            instructions::effect_fence(db, &session)?;
            let admitted: bool = db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM btcc_turns WHERE session_id=?1 AND turn_id=?2)",
                    params![session, turn],
                    |r| r.get(0),
                )
                .map_err(sql)?;
            check(admitted, "instruction_scope_invalid")?;
            let (scope_id, revision_id, objective) = if let Some(plan) =
                reads::plan(db, &session)?.filter(|p| p.status != "completed")
            {
                let current: Option<String> = db
                    .query_row(
                        "SELECT current_task_id FROM wm_sessions WHERE session_id=?1",
                        [&session],
                        |r| r.get(0),
                    )
                    .map_err(sql)?;
                let task = tasks::load(
                    db,
                    &plan.scope_id,
                    &plan.id,
                    &current.ok_or_else(|| error("running_task_required"))?,
                )?;
                check(
                    task.status == "running"
                        && task.assignee_session_id.as_deref() == Some(&session),
                    "running_task_required",
                )?;
                (
                    task.work_id,
                    format!(
                        "{}:{}:{}:{}",
                        plan.id, plan.tree_version, task.id, task.revision
                    ),
                    task.description,
                )
            } else {
                (
                    format!("TURN:{turn}"),
                    turn.clone(),
                    "Direct admitted action".into(),
                )
            };
            Ok(WorkModelEffectGrant {
                scope_id,
                revision_id,
                session: session.clone(),
                turn,
                objective,
                repository,
                publication: None,
                control_epoch: instructions::epoch(db, &session)?,
            })
        })
        .await
    }

    pub async fn effect_specs(&self, session: String) -> Result<Vec<SpecRef>> {
        self.lane(move |db| {
            let Some(plan) = reads::plan(db, &session)?.filter(|p| p.status != "completed") else {
                return Ok(vec![]);
            };
            let current: Option<String> = db
                .query_row(
                    "SELECT current_task_id FROM wm_sessions WHERE session_id=?1",
                    [&session],
                    |r| r.get(0),
                )
                .map_err(sql)?;
            let task = tasks::load(
                db,
                &plan.scope_id,
                &plan.id,
                &current.ok_or_else(|| error("running_task_required"))?,
            )?;
            check(task.status == "running", "running_task_required")?;
            reads::ancestors(db, &session, &task.spec_ref.node_id)
        })
        .await
    }
}
