//! Diagnostics shared by the durable command owners.

/// The standard panic hook logs the originating file:line before unwinding;
/// this records the owner that caught it, including non-string payloads.
pub(super) fn report(owner: &str, payload: &(dyn std::any::Any + Send)) {
    let message = payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("non-string panic payload");
    butler_core::diagnostic!("[{owner}] caught operation panic: {message}");
}
