//! Persisted scope for routing turn-only Work operations to their authoritative store.

use rusqlite::OptionalExtension;

use super::{SessionWorkRepository, StorageError, common::error};
use crate::btcc::BtccError;
use crate::btcc::StorageCode;

pub(crate) enum PersistedWorkTurnScope {
    Unbound {
        session_id: String,
    },
    Session,
    Project {
        session_id: String,
        app_project_id: String,
        ledger_project_id: String,
    },
}

impl SessionWorkRepository {
    pub(crate) async fn persisted_scope_for_turn(
        &self,
        turn_id: String,
    ) -> Result<Option<PersistedWorkTurnScope>, BtccError> {
        self.read(move |db| {
            let mut query = db
                .prepare(
                    "SELECT work.session_id,work.scope_kind,work.scope_ref,work.ledger_project_id \
                 FROM btcc_guided_turn_work_bindings binding \
                 JOIN btcc_guided_works work ON work.work_id=binding.work_id \
                 WHERE binding.turn_id=?1 AND binding.is_current=1 \
                 ORDER BY binding.revision DESC LIMIT 2",
                )
                .map_err(StorageError::sqlite)?;
            let rows = query
                .query_map([&turn_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })
                .map_err(StorageError::sqlite)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::sqlite)?;
            if rows.len() > 1 {
                return Err(error(
                    StorageCode::WorkScopeTurnBindingAmbiguous,
                    "Work Turn binding is ambiguous",
                ));
            }
            let Some((session_id, kind, scope_ref, ledger_project_id)) = rows.into_iter().next()
            else {
                let session_id = db
                    .query_row(
                        "SELECT session_id FROM btcc_turns WHERE turn_id=?1",
                        [&turn_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(StorageError::sqlite)?;
                return Ok(
                    session_id.map(|session_id| PersistedWorkTurnScope::Unbound { session_id })
                );
            };
            if kind == "session" {
                return Ok(Some(PersistedWorkTurnScope::Session));
            }
            let ledger_project_id =
                ledger_project_id
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        error(
                            StorageCode::WorkScopeProjectProjectionIncomplete,
                            "Project Work projection is incomplete",
                        )
                    })?;
            Ok(Some(PersistedWorkTurnScope::Project {
                session_id,
                app_project_id: scope_ref,
                ledger_project_id,
            }))
        })
        .await
    }
}
