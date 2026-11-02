use crate::btcc::BtccError;

/// Logs why a failed Stop stays fenced and is redelivered, naming the turn and storage error without message content.
pub(super) fn log(turn_id: &str, error: &BtccError) {
    let message = error.message().replace(['\n', '\r'], " ");
    butler_core::diagnostic!(
        "[native-btcc] stop persistence failed turn_id={turn_id} code={} error={message}",
        error.code(),
    );
}
