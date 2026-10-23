//! A change-driven snapshot of ready reservations; assignment rechecks readiness.
use super::*;
use crate::work_queries::Query;
use rusqlite::params;

#[derive(Debug, Clone)]
pub struct ReadyStart {
    pub task_id: String,
    pub work_id: String,
    pub coordinator_session: String,
    pub reserved_session_id: String,
}
pub fn ready_starts(db: &Connection) -> Result<Vec<ReadyStart>> {
    let mut starts = Vec::new();
    for work in rows(db, Query::ReadyWorks.sql(), [])? {
        let Some(coordinator) = work["home_session_id"].as_str() else {
            continue;
        };
        for chain in rows(
            db,
            Query::TaskChains.sql(),
            params![text(&work, "id")?, "active"],
        )? {
            for id in ready_tasks(db, text(&chain, "id")?)? {
                let task = read_task(db, &id)?;
                if let Some(reserved) = task["reserved_session_id"].as_str()
                    && task["assignee_session_id"].is_null()
                    && matches!(task["status"].as_str(), Some("pending" | "waiting"))
                {
                    starts.push(ReadyStart {
                        task_id: id,
                        work_id: text(&work, "id")?.into(),
                        coordinator_session: coordinator.into(),
                        reserved_session_id: reserved.into(),
                    });
                }
            }
        }
    }
    Ok(starts)
}
