//! One App query and one BTCC batch for every coordinator in a navigation view.
use super::*;
use crate::gateway::application::{app_error, work_model};
use serde_json::json;
use std::collections::BTreeMap;
impl AppApplication {
    pub(crate) async fn task_sessions_owned(
        &self,
        chats: Vec<String>,
    ) -> Result<BTreeMap<String, Value>, GatewayApplicationError> {
        if chats.is_empty() || self.dependencies.work_model.changes().is_none() {
            return Ok(BTreeMap::new());
        }
        let rows=self.storage.read(move |db| {
            db.prepare(work_model::sql::NESTED_SESSIONS).map_err(super::super::AppStorageError::sqlite)?
                .query_map([json!(chats).to_string()],|r|Ok(json!({"session_id":r.get::<_,String>(0)?,"task_id":r.get::<_,String>(1)?,"work_id":r.get::<_,String>(2)?,"coordinator":r.get::<_,String>(3)?,"title":r.get::<_,Option<String>>(4)?})))
                .map_err(super::super::AppStorageError::sqlite)?.collect::<rusqlite::Result<Vec<_>>>().map_err(super::super::AppStorageError::sqlite)
        }).await.map_err(app_error)?;
        let sessions = rows
            .iter()
            .filter_map(|r| r["session_id"].as_str().map(str::to_owned))
            .collect();
        let states = match self
            .dependencies
            .work_model
            .task_session_states(sessions)
            .await
        {
            Ok(rows) => rows,
            Err(error) => {
                tracing::error!(%error,"Task session status lookup failed");
                Vec::new()
            }
        };
        let states: BTreeMap<_, _> = states
            .into_iter()
            .filter_map(|r| Some((r["session_id"].as_str()?.to_owned(), r)))
            .collect();
        let mut groups: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for mut row in rows {
            if let Some(state) = row["session_id"].as_str().and_then(|id| states.get(id)) {
                for field in [
                    "title",
                    "status",
                    "chain_created_at",
                    "chain_id",
                    "step_index",
                    "stack_position",
                ] {
                    row[field] = state[field].clone();
                }
            }
            let Some(coordinator) = row["coordinator"].as_str().map(str::to_owned) else {
                continue;
            };
            groups.entry(coordinator).or_default().push(row);
        }
        Ok(groups
            .into_iter()
            .map(|(chat, mut rows)| {
                rows.sort_by_cached_key(|r| {
                    (
                        r["chain_created_at"].as_i64(),
                        r["chain_id"].as_str().map(str::to_owned),
                        r["step_index"].as_i64(),
                        r["stack_position"].as_i64(),
                        r["session_id"].as_str().map(str::to_owned),
                    )
                });
                (chat, json!(rows))
            })
            .collect())
    }
}
