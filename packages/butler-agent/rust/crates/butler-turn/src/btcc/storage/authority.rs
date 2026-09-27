//! Synchronous authority fragments used inside other BTCC transactions.

mod close;
mod query;
mod write;

pub(super) use close::{close_pending_self_session_requests, close_pending_source_work_requests};
pub(crate) use repository::SqliteAuthorityRepository;

mod repository;
