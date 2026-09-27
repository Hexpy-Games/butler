use std::collections::HashMap;

use rusqlite::Connection;

use super::super::super::{AppSessionSummary, AppStorageError};
use crate::conversation::conversation_session_id_for_durable_session;

pub(super) struct ProjectSessionLinks {
    by_canonical_id: HashMap<String, Vec<String>>,
}

impl ProjectSessionLinks {
    pub(super) fn empty() -> Self {
        Self {
            by_canonical_id: HashMap::new(),
        }
    }

    pub(super) fn read(db: &Connection, project_id: &str) -> Result<Self, AppStorageError> {
        let mut statement = db
            .prepare(
                "SELECT id,conversation_session_id FROM chats WHERE project_id=?1 \
                 AND conversation_session_id IS NOT NULL",
            )
            .map_err(AppStorageError::sqlite)?;
        let links = statement
            .query_map([project_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(AppStorageError::sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppStorageError::sqlite)?;
        let mut by_canonical_id = HashMap::<String, Vec<String>>::new();
        for (chat_id, session_id) in links {
            by_canonical_id.entry(session_id).or_default().push(chat_id);
        }
        Ok(Self { by_canonical_id })
    }

    pub(super) fn resolve<'a>(
        &self,
        durable_session_id: &str,
        sessions: &'a [AppSessionSummary],
    ) -> Option<&'a AppSessionSummary> {
        let canonical = conversation_session_id_for_durable_session(durable_session_id);
        let ids = self.by_canonical_id.get(&canonical)?;
        if ids.len() != 1 {
            return None;
        }
        sessions.iter().find(|session| session.id == ids[0])
    }
}
