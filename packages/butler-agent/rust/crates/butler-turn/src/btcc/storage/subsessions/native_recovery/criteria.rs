//! Retained acceptance criteria become immutable Spec detail before execution.
use butler_core::json::at;
use butler_work::{store, work_types::ScopeKind};
use serde_json::{Value, json};

pub(super) fn bind(
    tx: &store::Transaction<'_>,
    row: &crate::btcc::StoredSubsessionDelegation,
    task: Value,
) -> store::Result<Value> {
    let task_id = text(&task, "/id")?;
    if tx
        .prepare(store::execution_sql::CRITERIA)?
        .exists([task_id])?
    {
        return Ok(task);
    }
    let work = store::read_work(tx, text(&task, "/work_id")?)?;
    let spec: Value = serde_json::from_str(text(&task, "/spec_ref")?)?;
    let node = format!("recovered-spec-{}", row.delegation_id);
    let ctx = super::context();
    store::create_spec_node(
        tx,
        &ctx,
        &store::NewSpecNode {
            id: node.clone(),
            scope_kind: if at(&work, "/scope_kind") == "project" {
                ScopeKind::Project
            } else {
                ScopeKind::Session
            },
            scope_ref: text(&work, "/scope_ref")?.into(),
            work_id: Some(text(&work, "/id")?.into()),
            parent_node_id: Some(text(&spec, "/node_id")?.into()),
            concern_id: node.clone(),
        },
        &store::Registration::Private,
    )?;
    let checks = if row.packet.acceptance_criteria.is_empty() {
        vec![row.packet.objective.clone()]
    } else {
        row.packet.acceptance_criteria.clone()
    };
    publish(tx, &ctx, &node, &row.packet.objective, &checks)?;
    let refs = checks
        .iter()
        .enumerate()
        .map(|(i, _)| store::execution::CriterionRef {
            node_id: node.clone(),
            node_revision: 1,
            criterion_id: format!("c{i}"),
        })
        .collect();
    store::edit_task_fields(
        tx,
        &ctx,
        task_id,
        at(&task, "/revision")
            .as_i64()
            .ok_or(store::Error::Invalid("revision"))?,
        &store::tool_ops::TaskPatch {
            title: None,
            description: None,
            acceptance_refs: Some(refs),
        },
        false,
    )
}

fn publish(
    tx: &store::Transaction<'_>,
    ctx: &store::Context,
    node: &str,
    goal: &str,
    checks: &[String],
) -> store::Result<()> {
    let body = store::put_body(tx, &json!({"goal":goal,"criteria":checks}).to_string())?;
    store::publish_spec(
        tx,
        ctx,
        node,
        0,
        &store::Publication {
            revision: 1,
            body_hash: body,
            parser_version: "brief.v1".into(),
            authoring_instruction_id: None,
            criteria: checks
                .iter()
                .enumerate()
                .map(|(i, text)| store::Criterion {
                    id: format!("c{i}"),
                    part_id: format!("criterion-{i}"),
                    text: text.clone(),
                })
                .collect(),
        },
    )?;
    store::activate_spec(tx, ctx, node, 1, None, 1)?;
    Ok(())
}
fn text<'a>(value: &'a Value, pointer: &str) -> store::Result<&'a str> {
    at(value, pointer)
        .as_str()
        .ok_or(store::Error::Invalid("retained Task field"))
}
