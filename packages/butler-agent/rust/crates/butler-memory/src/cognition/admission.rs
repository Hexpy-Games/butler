//! Conversation admission uses the serving owner's durable reset boundary.
use super::{CognitionCode, CognitionConversationSourceNotice, CognitionError, CognitionResult};
use butler_platform::sqlite;
use rusqlite::OpenFlags;
use std::path::Path;

pub(super) fn assert_admitted(
    graph: &Path,
    notice: &CognitionConversationSourceNotice,
) -> CognitionResult<()> {
    let db =
        sqlite::open_with_flags(graph, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(unavailable)?;
    let (kind, id) = match notice {
        CognitionConversationSourceNotice::Turn { turn_id, .. } => ("turn", turn_id),
        CognitionConversationSourceNotice::Standalone { message_id, .. } => ("message", message_id),
    };
    if crate::coordination::admission_suppressed(&db, kind, id).map_err(unavailable)? {
        return Err(CognitionError::new(
            CognitionCode::MemorySourceIneligible,
            "Source excluded by reset boundary",
        ));
    }
    Ok(())
}

fn unavailable(source: impl std::error::Error + Send + Sync + 'static) -> CognitionError {
    CognitionError::new(
        CognitionCode::MemoryGenerationUnavailable,
        "Reset admission boundary is unavailable",
    )
    .with_source(source)
}
