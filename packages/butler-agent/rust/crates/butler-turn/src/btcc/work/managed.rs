//! Opt-in canonical Spec/Plan/Work/Task contracts and invariants.
mod contracts;
mod effects;
mod service;
mod validation;

pub use contracts::*;
pub use effects::WorkModelEffectGrant;
pub use service::WorkModelService;
pub(crate) use validation::{check, validate_bundle};

use crate::btcc::BtccError;

pub(crate) fn error(code: &str) -> BtccError {
    BtccError::relayed(code.to_owned(), code)
}

pub fn fingerprint<T: serde::Serialize>(value: &T) -> Result<String, BtccError> {
    use sha2::{Digest, Sha256};
    let bytes = serde_json::to_vec(value)
        .map_err(|source| error("work_model_encoding_failed").with_source(source))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub fn stable_id(kind: &str, scope: &str, key: &str) -> Result<String, BtccError> {
    Ok(format!("{kind}-{}", &fingerprint(&(scope, key))?[..24]))
}
