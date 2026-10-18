//! Application acceptance fences FIFO dispatch and publishes the durable live event.
use super::*;
impl AppApplication {
    pub(super) fn reset_data_owned(&self, input: Value) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move {
            let port = this
                .dependencies
                .data_reset
                .as_ref()
                .ok_or_else(GatewayApplicationError::internal)?;
            let data = port.request(input).await?;
            this.queue_wake.cancel();
            this.storage.execute(|db| {
                db.execute("UPDATE session_queued_messages SET state='failed',safe_error_code='service_resetting',claim_id=NULL,claim_owner=NULL,lease_expires_at=NULL WHERE state IN ('queued','dispatching')", [])
                    .map_err(AppStorageError::sqlite)?;
                Ok(())
            }).await.map_err(app_error)?;
            let payload = serde_json::json!({"operation_id":data["operation_id"]})
                .as_object()
                .cloned()
                .unwrap_or_default();
            this.publish_gateway_event_owned("data.reset_started", payload)
                .await?;
            Ok(data)
        })
    }
    pub(super) async fn settings_with_generation(&self) -> Result<Value, GatewayApplicationError> {
        let mut settings = self.worker_profile_settings().await?;
        if let Some(port) = &self.dependencies.data_reset {
            settings["data_generation"] = port.generation().into();
        }
        Ok(settings)
    }
    pub(super) fn settings_read_owned(&self) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.settings_with_generation().await })
    }
}
