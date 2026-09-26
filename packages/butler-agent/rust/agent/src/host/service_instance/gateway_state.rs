use std::path::Path;

use super::{
    InstanceRecord, instance_record_path, read_record_at, record::acquire_record_update_lock,
    record::record_update_lock_path, validate_write_destinations,
};
use crate::host::ResolvedInstallation;

pub(crate) fn mark_gateway_state(
    data_root: &Path,
    nonce: &str,
    installation: &ResolvedInstallation,
    app_enabled: bool,
    app_endpoint: Option<String>,
    app_auth_required: bool,
) -> Result<(), String> {
    validate_write_destinations(data_root, installation)?;
    let path = instance_record_path(data_root);
    let _lock = acquire_record_update_lock(&record_update_lock_path(data_root))?;
    let mut record: InstanceRecord = read_record_at(&path)?.ok_or_else(|| {
        "native_service_instance_ambiguous: instance record is missing".to_owned()
    })?;
    if record.nonce != nonce {
        return Err("native_service_instance_changed".into());
    }
    if record.state == "stopping" {
        return Ok(());
    }
    if !matches!(record.state.as_str(), "starting" | "ready") {
        return Err("native_service_instance_ambiguous: invalid gateway transition".into());
    }
    record.app_enabled = app_enabled;
    record.app_endpoint = app_endpoint;
    record.app_auth_required = app_auth_required;
    super::record::write_record(&path, &record)
}
