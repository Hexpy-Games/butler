//! Verify every affected node and its inherited constraints before SQL mutation.
use super::*;

impl WorkModelRepository {
    pub async fn operation_specs(
        &self,
        session: String,
        command: WorkModelCommand,
    ) -> Result<Vec<SpecRef>> {
        self.lane(move |db| {
            let plan = reads::require_plan(db, &session)?;
            let mut nodes = Vec::new();
            affected_nodes(db, &plan, &command, &mut nodes)?;
            if nodes.is_empty() {
                nodes.push(plan.root_node_id);
            }
            let mut refs = Vec::new();
            for node in nodes {
                for reference in reads::ancestors(db, &session, &node)? {
                    if !refs.contains(&reference) {
                        refs.push(reference);
                    }
                }
            }
            Ok(refs)
        })
        .await
    }
}

fn affected_nodes(
    db: &Connection,
    plan: &reads::Plan,
    command: &WorkModelCommand,
    nodes: &mut Vec<String>,
) -> Result<()> {
    match command {
        WorkModelCommand::Batch { operations, .. } => {
            for operation in operations {
                affected_nodes(db, plan, operation, nodes)?;
            }
        }
        WorkModelCommand::Start { task_id, .. }
        | WorkModelCommand::Submit { task_id, .. }
        | WorkModelCommand::Review { task_id, .. }
        | WorkModelCommand::Complete { task_id, .. }
        | WorkModelCommand::Remove { task_id, .. }
        | WorkModelCommand::Edit { task_id, .. }
        | WorkModelCommand::ResolveDraft { task_id, .. }
        | WorkModelCommand::Block { task_id, .. }
        | WorkModelCommand::Step { task_id, .. } => nodes.push(
            tasks::load(db, &plan.scope_id, &plan.id, task_id)?
                .spec_ref
                .node_id,
        ),
        WorkModelCommand::Add { spec_ref, .. } => nodes.push(spec_ref.node_id.clone()),
        WorkModelCommand::Reorder { task_ids } => {
            for id in task_ids {
                nodes.push(
                    tasks::load(db, &plan.scope_id, &plan.id, id)?
                        .spec_ref
                        .node_id,
                );
            }
        }
        WorkModelCommand::Dependencies { add, remove } => {
            for edge in add.iter().chain(remove) {
                for id in [&edge.from, &edge.to] {
                    nodes.push(
                        tasks::load(db, &plan.scope_id, &plan.id, id)?
                            .spec_ref
                            .node_id,
                    );
                }
            }
        }
        WorkModelCommand::CompleteWork { work_id } => nodes.push(
            db.query_row(
                "SELECT node_id FROM wm_works WHERE scope_id=?1 AND plan_id=?2 AND id=?3",
                params![plan.scope_id, plan.id, work_id],
                |r| r.get(0),
            )
            .map_err(sql)?,
        ),
        _ => {}
    }
    Ok(())
}
