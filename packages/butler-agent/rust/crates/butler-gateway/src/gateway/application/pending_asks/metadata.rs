//! Map runtime owners through indexed App identities; page past non-App owners.
use super::*;

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

fn decorate(
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
            ask.session_id = chat.clone();
            ask.session_title = Some(title.clone());
        }
    }
    asks.retain(|ask| ask.session_title.is_some());
    Ok(asks)
}
