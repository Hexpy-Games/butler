//! Map runtime owners through indexed App identities; page past non-App owners.
use super::*;
use rusqlite::params;

pub(crate) const CHAT_MESSAGE: &str = "SELECT COALESCE((SELECT id FROM messages INDEXED BY messages_assistant_turn_idx WHERE chat_id=?1 AND turn_id=?2 AND role='assistant' ORDER BY rowid DESC LIMIT 1),(SELECT user_message_id FROM turns WHERE id=?2 AND chat_id=?1))";

impl AppApplication {
    pub(super) async fn authority_ask_page(
        &self,
        owner: Option<String>,
        limit: usize,
        mut before: Option<String>,
    ) -> Result<Vec<PendingAsk>, GatewayApplicationError> {
        let mut visible = Vec::new();
        loop {
            let rows = self
                .dependencies
                .authority_handoff
                .pending_asks(owner.clone(), limit, before.clone())
                .await?;
            let exhausted = owner.is_some() || rows.len() < limit;
            before = rows.last().map(cursor);
            visible.extend(
                self.storage
                    .read(move |db| decorate(db, rows))
                    .await
                    .map_err(app_error)?,
            );
            if exhausted || visible.len() >= limit {
                break;
            }
        }
        Ok(visible)
    }
}

pub(super) fn decorate(
    db: &rusqlite::Connection,
    mut asks: Vec<PendingAsk>,
) -> Result<Vec<PendingAsk>, AppStorageError> {
    let mut owners = std::collections::HashMap::new();
    for ask in &mut asks {
        let metadata = match owners.entry(ask.session_id.clone()) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                let metadata = if let Some(chat) =
                    super::super::sessions::identity::resolve_owner(db, &ask.session_id)?
                {
                    let (title, archived): (String, bool) = db
                        .query_row(CHAT, [&chat], |r| Ok((r.get(0)?, r.get(1)?)))
                        .map_err(AppStorageError::sqlite)?;
                    (!archived).then_some((chat, title))
                } else {
                    None
                };
                entry.insert(metadata)
            }
        };
        if let Some((chat, title)) = metadata {
            let source =
                super::super::sessions::identity::resolve_owner(db, &ask.source_session_id)?;
            ask.source_message_id = None;
            if let Some(source) = source {
                ask.source_session_id = source.clone();
                ask.source_message_id = db
                    .query_row(CHAT_MESSAGE, params![source, ask.source_turn_id], |r| {
                        r.get(0)
                    })
                    .map_err(AppStorageError::sqlite)?;
            }
            ask.session_id = chat.clone();
            ask.session_title = Some(title.clone());
        }
    }
    asks.retain(|ask| ask.session_title.is_some());
    Ok(asks)
}
