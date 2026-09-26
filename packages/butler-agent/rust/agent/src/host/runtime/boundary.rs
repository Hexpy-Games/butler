use std::path::Path;

use crate::btcc::BtccError;

pub(super) fn setup(error: impl std::fmt::Display) -> BtccError {
    BtccError::relayed("native_runtime_initialization_failed", error.to_string())
}

pub(super) fn validate_data_installation_boundary(
    data_root: &Path,
    installation_root: &Path,
) -> Result<(), BtccError> {
    let data_root = data_root.canonicalize().map_err(setup)?;
    let installation_root = installation_root.canonicalize().map_err(setup)?;
    if data_root.starts_with(&installation_root) || installation_root.starts_with(&data_root) {
        return Err(BtccError::relayed(
            "native_path_configuration_invalid",
            "DATA overlaps the native installation.",
        ));
    }
    Ok(())
}
