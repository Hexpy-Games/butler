use super::require_analysis_access;
use butler_turn::btcc::{AccessMode, ToolExecutionError};

/// Security boundary (#236): the image tool itself analyzes an attached
/// image in full access and ask-first without asking, and never in read-only,
/// whatever surface offered it.
#[test]
fn image_analysis_runs_in_full_access_and_ask_first_never_in_read_only() {
    for (access, allowed) in [
        (AccessMode::FullAccess, true),
        (AccessMode::AskAlways, true),
        (AccessMode::AskExceptReads, true),
        (AccessMode::ReadOnly, false),
    ] {
        match require_analysis_access(&access) {
            Ok(()) => assert!(allowed, "{access:?} analyzed an image"),
            Err(ToolExecutionError::Integrity(error)) => {
                assert!(!allowed, "{access:?} refused: {error}");
                assert_eq!(error.code(), "image_analysis_requires_full_access");
            }
        }
    }
}
