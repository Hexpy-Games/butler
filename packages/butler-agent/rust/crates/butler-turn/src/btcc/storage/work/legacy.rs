mod projection;
mod writer;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::btcc::work::LegacyProjectWorkSourceSnapshot;
use crate::btcc::work::{LegacyImport, WorkTurnScope};

use super::{StorageError, StorageResult, common};

#[derive(Clone)]
struct LegacyProgram {
    id: String,
    session_id: String,
    goal_ref: String,
    plan_ref: Option<String>,
    revision: u64,
}

pub(in crate::btcc::storage) fn project_external_legacy_work(
    source: &LegacyProjectWorkSourceSnapshot,
) -> StorageResult<projection::Projection> {
    let works = source
        .works
        .iter()
        .map(|item| LegacyItem {
            id: item.record_id.clone(),
            status: item.status.clone(),
            content: item.content.clone(),
        })
        .collect::<Vec<_>>();
    let tasks = source
        .tasks
        .iter()
        .map(|item| LegacyItem {
            id: item.record_id.clone(),
            status: item.status.clone(),
            content: item.content.clone(),
        })
        .collect::<Vec<_>>();
    projection::project(&source.goal_contract, &source.plan, &works, &tasks, |id| {
        Ok(source
            .referenced_records
            .iter()
            .find(|row| row.record_id == id)
            .map(|row| row.content.clone())
            .unwrap_or(Value::Null))
    })
}

#[derive(Clone)]
pub(super) struct LegacyItem {
    pub id: String,
    pub status: String,
    pub content: Value,
}

pub(super) fn import(
    db: &Connection,
    scope: &WorkTurnScope,
    clock: &dyn Fn() -> String,
) -> StorageResult<Option<LegacyImport>> {
    let fallback_turn = common::turn(db, scope)?;
    if !has_tables(db)? {
        return Ok(None);
    }
    let Some(program) = find_open_program(db, scope)? else {
        return Ok(None);
    };
    let goal = read_record(db, &program.goal_ref)?;
    let plan = program
        .plan_ref
        .as_deref()
        .map(|id| read_record(db, id))
        .transpose()?
        .unwrap_or(Value::Null);
    let works = load_items(db, "work", &program.id)?;
    let tasks = load_items(db, "task", &program.id)?;
    let projection = projection::project(&goal, &plan, &works, &tasks, |id| read_record(db, id))?;
    let origin = find_origin(db, &program, projection.original_message_id.as_deref())?
        .unwrap_or(fallback_turn);
    writer::import(
        db,
        scope,
        &program.id,
        program.revision,
        &projection,
        &origin,
        clock,
    )
}

fn has_tables(db: &Connection) -> StorageResult<bool> {
    let count: u64 = db.query_row("SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name IN ('btcc_programs','btcc_work_items','btcc_tasks','btcc_records','btcc_ledger_mutations')", [], |row| row.get(0)).map_err(StorageError::sqlite)?;
    Ok(count == 5)
}

fn find_open_program(
    db: &Connection,
    scope: &WorkTurnScope,
) -> StorageResult<Option<LegacyProgram>> {
    db.query_row("SELECT program_id, session_id, goal_contract_ref, accepted_plan_ref, manifest_revision FROM btcc_programs program WHERE scope_kind = 'session' AND scope_id = ?1 AND session_id = ?1 AND frontier NOT IN ('closed','cancelled') ORDER BY (SELECT MAX(m.rowid) FROM btcc_ledger_mutations m WHERE m.program_id = program.program_id) DESC, program.rowid DESC LIMIT 1", [&scope.session_id], |row| Ok(LegacyProgram { id: row.get(0)?, session_id: row.get(1)?, goal_ref: row.get(2)?, plan_ref: row.get(3)?, revision: row.get(4)? }))
        .optional().map_err(StorageError::sqlite)
}

fn load_items(db: &Connection, kind: &str, program_id: &str) -> StorageResult<Vec<LegacyItem>> {
    let sql = if kind == "work" {
        "SELECT work_id, work_ref, status FROM btcc_work_items WHERE program_id = ?1 AND is_active = 1 ORDER BY rowid"
    } else {
        "SELECT task_id, task_ref, status FROM btcc_tasks WHERE program_id = ?1 AND is_active = 1 ORDER BY rowid"
    };
    let mut statement = db.prepare(sql).map_err(StorageError::sqlite)?;
    let rows = statement
        .query_map([program_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(StorageError::sqlite)?;
    rows.map(|row| {
        let (item_id, reference, status) = row.map_err(StorageError::sqlite)?;
        let id = serde_json::from_str::<Value>(&reference)
            .ok()
            .and_then(|value| {
                value
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned)
            })
            .unwrap_or(item_id);
        let content = read_record(db, &id)?;
        Ok(LegacyItem {
            id,
            status,
            content,
        })
    })
    .collect()
}

fn read_record(db: &Connection, id: &str) -> StorageResult<Value> {
    let body: Option<String> = db
        .query_row(
            "SELECT content_json FROM btcc_records WHERE record_id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    Ok(body
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or(Value::Null))
}

fn find_origin(
    db: &Connection,
    program: &LegacyProgram,
    message_id: Option<&str>,
) -> StorageResult<Option<common::TurnRow>> {
    let exact = db.query_row("SELECT turn_id, session_id, original_message_id, semantic_state, execution_fence FROM btcc_turns WHERE session_id = ?1 AND (goal_contract_ref = ?2 OR original_message_id = ?3) ORDER BY CASE WHEN original_message_id = ?3 THEN 0 ELSE 1 END, rowid LIMIT 1", params![program.session_id, program.goal_ref, message_id.unwrap_or("")], |row| Ok(common::TurnRow { id: row.get(0)?, session_id: row.get(1)?, message_id: row.get(2)?, state: row.get(3)?, fence: row.get(4)? })).optional().map_err(StorageError::sqlite)?;
    if exact.is_some() {
        return Ok(exact);
    }
    let mut statement = db.prepare("SELECT turn_id, session_id, original_message_id, semantic_state, execution_fence, managed_state_json FROM btcc_turns WHERE session_id = ?1 AND route = 'managed' ORDER BY rowid DESC").map_err(StorageError::sqlite)?;
    let rows = statement
        .query_map([&program.session_id], |row| {
            Ok((
                common::TurnRow {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    message_id: row.get(2)?,
                    state: row.get(3)?,
                    fence: row.get(4)?,
                },
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(StorageError::sqlite)?;
    for row in rows {
        let (turn, managed) = row.map_err(StorageError::sqlite)?;
        if managed
            .as_deref()
            .and_then(|json| serde_json::from_str::<Value>(json).ok())
            .and_then(|value| {
                value
                    .get("programId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .as_deref()
            == Some(&program.id)
        {
            return Ok(Some(turn));
        }
    }
    Ok(None)
}
