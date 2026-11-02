//! Composition-owned canon link and derived progress; BTCC rows are read only.
mod feed;
mod progress;
pub mod queries;
use super::*;
pub use feed::{catch_up, prepare};
pub use progress::{enrich, progress, project_works};
pub(crate) use progress::{queue_outcome, step_unfinished};
pub fn epic_running(db: &Connection, epic: &str) -> Result<bool> {
    let works = rows(db, Query::Works.sql(), [epic])?;
    for (index, work) in works.iter().enumerate() {
        if progress::current(&works, index) && progress::running(db, work)? {
            return Ok(true);
        }
    }
    Ok(false)
}
/// Protect admission before its Work link, unless the queue says later chat
/// Turns no longer belong to this step. Linked Works use the progress check.
pub fn epic_delete_running(db: &Connection, epic: &str) -> Result<bool> {
    let active: bool = db.query_row(Query::DeleteRunning.sql(), [epic], |r| r.get(0))?;
    Ok(active || epic_running(db, epic)?)
}
pub type ProjectViews = std::collections::HashMap<String, Value>;
use queries::Query;
use rusqlite::params;

pub fn epic_refs(refs: &[String]) -> Vec<&str> {
    refs.iter()
        .filter_map(|r| r.strip_prefix("canon:epic/"))
        .collect()
}

/// Exact model feedback, evaluated before the plan command can commit.
pub fn precheck(
    db: &Connection,
    session: &str,
    work: Option<&str>,
    refs: &[String],
) -> Result<Option<Value>> {
    let epics = epic_refs(refs);
    if epics.len() > 1 {
        let list = epics
            .iter()
            .map(|id| format!("canon:epic/{id}"))
            .collect::<Vec<_>>()
            .join(", ");
        return Ok(Some(
            json!({"code":"canon_epic_refs_multiple","message":format!("governing_refs names {} epics ({list}); one Work serves one epic. Call replace_work_plan again with only the epic this Work processes, and process each other epic in its own Work in a later Turn.",epics.len())}),
        ));
    }
    let Some(epic) = epics.first() else {
        return Ok(None);
    };
    let linked: Option<String> = work
        .map(|work| {
            db.query_row(Query::Link.sql(), [work], |r| r.get(0))
                .optional()
        })
        .transpose()?
        .flatten();
    if let Some(linked) = linked {
        return Ok((linked != *epic).then(|| json!({"code":"canon_epic_link_conflict","message":format!("This Work is linked to canon:epic/{linked}, and a Work keeps its epic. Call replace_work_plan again with canon:epic/{linked}, or process canon:epic/{epic} in a new Work in a later Turn.")})));
    }
    let bound = db
        .query_row(Query::Bound.sql(), params![session, epic], |_| Ok(()))
        .optional()?
        .is_some();
    Ok((!bound).then(|| json!({"code":"canon_epic_not_bound","message":format!("canon:epic/{epic} is not bound to this conversation. If the user clearly means that epic, bind it with canon_read (view epic, bind true) and call replace_work_plan again; otherwise call it without the epic_ref so the Work stays private.")})))
}

pub fn link(
    tx: &Transaction<'_>,
    ctx: &Context,
    session: &str,
    work: &str,
    refs: &[String],
) -> Result<()> {
    if precheck(tx, session, Some(work), refs)?.is_some() {
        return Ok(());
    }
    let epics = epic_refs(refs);
    let Some(epic) = epics.first() else {
        return Ok(());
    };
    if tx.execute(
        Query::InsertLink.sql(),
        params![epic, work, session, ctx.now, ctx.actor.to_string()],
    )? > 0
    {
        advance_label(tx, ctx, epic, "in_progress")?;
        progress_event(tx, ctx, epic)?;
    }
    Ok(())
}

pub fn context(db: &Connection, session: &str) -> Result<Vec<Value>> {
    let epics = rows(
        db,
        crate::work_queries::Query::ConversationWork.sql(),
        [session],
    )?;
    epics.into_iter().map(|epic| {
        let id = text(&epic,"id")?;
        let nodes = rows(db, crate::work_queries::Query::WorkSpecNodes.sql(), [id])?;
        let mut data = json!({"epic_ref":format!("canon:epic/{id}"),"canon_status":epic["canon_status"],"untrusted_content":{"kind":"canon_epic","title":epic["title"]}});
        if epic["description"].as_str().is_some_and(|s| !s.is_empty()) { data["untrusted_content"]["description"] = epic["description"].clone(); }
        let tags = rows(db, super::api::sql::EPIC_TAGS, [id])?;
        if !tags.is_empty() { data["untrusted_content"]["tags"] = json!(tags.iter().map(|tag| &tag["name"]).collect::<Vec<_>>()); }
        let mut specs = Vec::new();
        for node in nodes {
            let Some(revision) = node["active_revision"].as_i64() else { continue; };
            let node_id = text(&node,"node_id")?;
            let criteria = rows(db, super::api::sql::SPEC_CRITERIA, params![node_id,revision])?.into_iter().map(|c| json!({"id":c["criterion_id"],"text":c["text"]})).collect::<Vec<_>>();
            specs.push(json!({"spec_ref":format!("canon:spec/{node_id}@{revision}"),"criteria":criteria}));
        }
        if !specs.is_empty() {
            data["spec_refs"] = json!(specs.iter().map(|s| &s["spec_ref"]).collect::<Vec<_>>());
            data["untrusted_content"]["specs"] = json!(specs);
        }
        let object = data.as_object_mut().ok_or(Error::Invalid("canon context"))?;
        let content = object.remove("untrusted_content").ok_or(Error::Invalid("canon content"))?;
        object.insert("untrusted_content".into(), content);
        Ok(data)
    }).collect()
}

fn advance_label(tx: &Transaction<'_>, ctx: &Context, id: &str, target: &str) -> Result<()> {
    let row = read_work(tx, id)?;
    let rank = |status: &str| match status {
        "planned" => 0,
        "in_progress" | "blocked" => 1,
        "in_review" => 2,
        _ => 3,
    };
    if rank(text(&row, "canon_status")?) >= rank(target) {
        return Ok(());
    }
    if target == "done" && epic_running(tx, id)? {
        return Err(Error::Running);
    }
    tx.execute(Query::AdvanceLabel.sql(), params![id, target, ctx.now])?;
    activity::status(tx, ctx, id, text(&row, "canon_status")?, target)?;
    event(
        tx,
        ctx,
        "work",
        id,
        row["revision"].as_i64().ok_or(Error::Invalid("revision"))? + 1,
        "label",
    )
}

pub(super) fn progress_event(tx: &Transaction<'_>, ctx: &Context, id: &str) -> Result<()> {
    let epic = read_work(tx, id)?;
    tx.execute(
        super::sql::OUTBOX,
        params![
            "canon.progress_changed",
            json!({"project_id":epic["project_id"],"epic_id":id}).to_string(),
            ctx.now
        ],
    )?;
    Ok(())
}

pub fn runtime_context(now: i64) -> Context {
    Context {
        now,
        actor: json!({"person":"버틀러","via":"butler"}),
    }
}
