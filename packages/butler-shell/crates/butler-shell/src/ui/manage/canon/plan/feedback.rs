//! `canonFeedback.ts`: a canon write never retries; a conflict tells the owner and reloads.
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use gpui::App;

use super::copy::words;

/// `canonWriteFailure`: toasts the failure and answers whether the caller must read again.
// A 409 is told apart by its status (`conflict`); every other refusal shows its code's sentence,
// else React's `requestFailed` fallback.
pub(super) fn write_failure(error: &Error, cx: &mut App) -> bool {
    let copy = words(Ds::get(cx).lang());
    let conflict = matches!(error, Error::Http(409, _));
    let message = if conflict {
        Toast::error(copy.conflict)
    } else {
        crate::ui::i18n::errors::toast(cx, error, copy.request_failed)
    };
    toast::show(cx, message);
    conflict
}
