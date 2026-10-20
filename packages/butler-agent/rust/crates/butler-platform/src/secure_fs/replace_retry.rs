//! Whether a refused rename-replace may be retried. The decision is pure, so
//! every platform compiles and tests it; the Windows backend calls it.

/// `ERROR_SHARING_VIOLATION` and `ERROR_LOCK_VIOLATION`.
pub(super) const SHARING_ERRORS: [i32; 2] = [32, 33];
/// `ERROR_ACCESS_DENIED`.
const ACCESS_DENIED: i32 = 5;

/// A DELETE-only reopen of the source or the target: success, or the raw OS
/// error code of its failure (`None` when the error carries none).
pub type DeleteProbe = Result<(), Option<i32>>;

/// ACCESS_DENIED can be a sharing or mapped-view conflict even when DELETE
/// opens succeed. Only confirmed permission failures stop the bounded retry.
/// `probes` runs only for ACCESS_DENIED; `None` (a read-only or unreadable
/// target) is final.
pub fn replacement_retry_allowed(
    rename_code: Option<i32>,
    probes: impl FnOnce() -> Option<[DeleteProbe; 2]>,
) -> bool {
    match rename_code {
        Some(code) if SHARING_ERRORS.contains(&code) => true,
        Some(ACCESS_DENIED) => {
            probes().is_some_and(|probes| probes.into_iter().all(probe_allows_retry))
        }
        _ => false,
    }
}

/// A successful DELETE open rules out a DACL denial. A sharing violation
/// also permits retry; any other probe failure is final.
fn probe_allows_retry(probe: DeleteProbe) -> bool {
    match probe {
        Ok(()) => true,
        Err(code) => code.is_some_and(|code| SHARING_ERRORS.contains(&code)),
    }
}
