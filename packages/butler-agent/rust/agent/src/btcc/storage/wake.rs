//! Exact persisted wake facts; validation never implies or creates authority.

use rusqlite::params;

use super::common::btcc_error;
use super::{BtccRepositories, StorageError};
use crate::btcc::PortFuture;
use crate::public_text::trim_js_whitespace;

#[derive(Clone, Debug)]
pub(crate) struct WakeAuthorization {
    pub source_turn_id: String,
    pub authorization_ref: String,
    pub result_scope_ref: Option<String>,
}

impl WakeAuthorization {
    fn has_required_refs(&self) -> bool {
        !trim_js_whitespace(&self.source_turn_id).is_empty()
            && !trim_js_whitespace(&self.authorization_ref).is_empty()
    }
}

impl BtccRepositories {
    pub(crate) fn validate_wake(&self, input: WakeAuthorization) -> PortFuture<'_, bool> {
        Box::pin(async move {
            if !input.has_required_refs() {
                return Ok(false);
            }
            self.storage
                .execute(move |db| {
                    db.query_row(
                        "SELECT EXISTS(SELECT 1 FROM btcc_wake_authorizations \
                         WHERE source_turn_id=?1 AND authorization_ref=?2 \
                         AND result_scope_ref=?3)",
                        params![
                            input.source_turn_id,
                            input.authorization_ref,
                            input.result_scope_ref.unwrap_or_default()
                        ],
                        |row| row.get(0),
                    )
                    .map_err(StorageError::sqlite)
                })
                .await
                .map_err(btcc_error)
        })
    }
}
