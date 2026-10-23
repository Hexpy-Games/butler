//! Both identity lookups are indexed; pinned against the App schema.
pub(super) const SESSION_TITLE: &str = "SELECT coalesce((SELECT title FROM chats WHERE runtime_session_hint=?1),(SELECT title FROM chats WHERE id=?2 AND runtime_session_hint IS NULL))";
