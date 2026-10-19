//! reqwest 0.12 protocol-NACK policy, executed here to log each wire attempt.
pub(super) fn safe(error: &reqwest::Error) -> bool {
    use std::error::Error;
    let mut source = error.source();
    while let Some(cause) = source {
        if let Some(error) = cause.downcast_ref::<h2::Error>() {
            return error.is_remote()
                && ((error.is_go_away() && error.reason() == Some(h2::Reason::NO_ERROR))
                    || (error.is_reset() && error.reason() == Some(h2::Reason::REFUSED_STREAM)));
        }
        source = cause.source();
    }
    false
}
