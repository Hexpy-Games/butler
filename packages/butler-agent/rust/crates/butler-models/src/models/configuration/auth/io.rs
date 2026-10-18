//! Bounded OAuth response and profile filesystem I/O.

use std::io::Write;
use std::path::Path;

use butler_platform::secure_fs;

use super::{AuthError, error};

/// Writes `bytes` to `path`, creating it as an owner-only file.
pub(in crate::models::configuration) async fn write_mode_600(
    path: &Path,
    bytes: &[u8],
) -> Result<(), AuthError> {
    let path = path.to_owned();
    let bytes = bytes.to_owned();
    tokio::task::spawn_blocking(move || {
        secure_fs::replace_private(
            &path,
            |file| {
                #[cfg(test)]
                super::super::durability_tests::interrupt_write(&path, file)?;
                file.write_all(&bytes)
            },
            std::convert::identity,
        )
    })
    .await
    .map_err(|source| write_error().with_source(source))?
    .map_err(|source| write_error().with_source(source))
}

fn write_error() -> AuthError {
    error(
        "provider_auth_write_failed",
        "OpenAI auth profile could not be written.",
    )
}
