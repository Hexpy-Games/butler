//! `canonFeedback.ts`: a canon write never retries; a conflict tells the owner and reloads.
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use gpui::App;

use super::copy::words;

/// `canonWriteFailure`: toasts the failure and answers whether the caller must read again.
// G-codes: the client returns no error codes, so only a 409 is told apart (`conflict`); every
// other refusal takes React's `requestFailed` fallback.
pub(super) fn write_failure(error: &Error, cx: &mut App) -> bool {
    let copy = words(Ds::get(cx).lang());
    let conflict = matches!(error, Error::Http(409));
    let message = if conflict {
        copy.conflict
    } else {
        copy.request_failed
    };
    toast::show(cx, Toast::error(message));
    conflict
}
