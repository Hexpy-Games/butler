//! Which stored messages the owner may see.
//!
//! A steward's delegated result reaches the parent chat as model input for a
//! turn: it is stored as a `user` message so the turn can read it, but it is
//! shown only through the steward projections, never as a chat bubble.
//!
//! Two markers identify one, both checked at read time so no data migration
//! is needed:
//! - the `subsession_result` control on the turn that owns the message;
//! - for rows written before that control existed, the structured refs the
//!   TypeScript gateway used to recognise them: a `Subsession result` first
//!   line and `Relation ref: relation-<hex>` / `Result ref: steward-result-<hex>`
//!   lines, each at a line start (GLOB cannot match a whole hex id, so the id
//!   must start with four hex digits).
//!
//! The TypeScript gateway filtered these on every message read and on the
//! live `message.created` event; the native cutover dropped that filter.

use rusqlite::{Connection, OptionalExtension};

use super::storage::AppStorageError;

/// SQL predicate, true when the `messages` row aliased `m` is owner-visible.
/// Every public message read (list, window, preview, export, branch context)
/// splices this same text.
macro_rules! owner_visible {
    () => {
        "NOT (m.role='user' AND (\
         (m.text GLOB 'Subsession result'||char(10)||'*' \
          AND m.text GLOB '*'||char(10)||'Relation ref: relation-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]*' \
          AND m.text GLOB '*'||char(10)||'Result ref: steward-result-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]*') \
         OR EXISTS (SELECT 1 FROM turns dt WHERE dt.user_message_id=m.id AND \
         CASE WHEN json_valid(dt.execution_controls_json) \
         THEN json_extract(dt.execution_controls_json,'$.subsession_result') END IS NOT NULL)))"
    };
}
pub(super) use owner_visible;

/// True when the message exists but is a delegated result kept off the chat.
pub(super) fn is_delegated_result(
    connection: &Connection,
    message_id: &str,
) -> Result<bool, AppStorageError> {
    let hidden: Option<bool> = connection
        .query_row(
            concat!(
                "SELECT NOT (",
                owner_visible!(),
                ") FROM messages m WHERE m.id=?1"
            ),
            [message_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    Ok(hidden.unwrap_or(false))
}
