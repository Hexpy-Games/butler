//! Instance publication keeps the complete record transaction on a blocking thread.
use super::{
    InstanceGuard, InstanceRecord, Path, acquire_record_update_lock, clear_stop_intent,
    read_record_at, validate_write_destinations, write_record,
};

impl InstanceGuard {
    pub(crate) async fn mark_ready(
        &mut self,
        app_enabled: bool,
        app_endpoint: Option<String>,
        app_auth_required: bool,
        ready_at: String,
    ) -> Result<(), crate::host::HostError> {
        self.update_record(move |current, data_root| {
            if current.state == "stopping" {
                return Err("native_service_start_cancelled".into());
            }
            if current.state != "starting" {
                return Err("native_service_instance_ambiguous: invalid startup transition".into());
            }
            clear_stop_intent(data_root).map_err(|source| {
                crate::host::HostError::new("native_service_instance_state_unavailable")
                    .with_source(source)
            })?;
            current.state = "ready".into();
            current.app_enabled = app_enabled;
            current.app_endpoint = app_endpoint;
            current.app_auth_required = app_auth_required;
            current.ready_at = Some(ready_at);
            Ok(())
        })
        .await
    }

    pub(crate) async fn publish_control(
        &mut self,
        endpoint: String,
        token: String,
    ) -> Result<(), crate::host::HostError> {
        self.update_record(move |current, _| {
            current.control_endpoint = Some(endpoint);
            current.control_token = Some(token);
            Ok(())
        })
        .await
    }

    async fn update_record(
        &mut self,
        update: impl FnOnce(&mut InstanceRecord, &Path) -> Result<(), crate::host::HostError>
        + Send
        + 'static,
    ) -> Result<(), crate::host::HostError> {
        let record_path = self.record_path.clone();
        let lock_path = self.record_update_lock_path.clone();
        let installation = self.installation.clone();
        let nonce = self.record.nonce.clone();
        self.record = tokio::task::spawn_blocking(move || {
            let data_root = record_path
                .parent()
                .and_then(Path::parent)
                .ok_or_else(|| "native_service_instance_record_path_invalid".to_owned())?;
            validate_write_destinations(data_root, &installation)?;
            let _lock = acquire_record_update_lock(&lock_path)?;
            let mut current = read_record_at(&record_path)?.ok_or_else(|| {
                "native_service_instance_ambiguous: instance record is missing".to_owned()
            })?;
            if current.nonce != nonce {
                return Err("native_service_instance_changed".into());
            }
            update(&mut current, data_root)?;
            write_record(&record_path, &current)?;
            Ok::<_, crate::host::HostError>(current)
        })
        .await
        .map_err(crate::host::HostError::from_error)??;
        Ok(())
    }
}
