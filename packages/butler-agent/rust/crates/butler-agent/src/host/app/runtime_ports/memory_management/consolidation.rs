use super::*;

impl AppMemoryManagement {
    pub(super) async fn start_consolidation(
        self,
        id: String,
    ) -> Result<Value, GatewayApplicationError> {
        let gate = self.daily.gate.clone();
        let admission = gate.admission.lock().await;
        if let Some(mut active) = gate.active() {
            active["already_active"] = json!(true);
            return Ok(active);
        }
        if !gate
            .writer_available()
            .await
            .map_err(GatewayApplicationError::internal_from)?
        {
            return Err(error(std::io::Error::other("Memory is in use")));
        }
        let started = chrono::DateTime::parse_from_rfc3339(&self.clock.now_iso())
            .map_err(GatewayApplicationError::internal_from)?
            .timestamp_millis();
        let receipt = gate.reserve(&id, "manual");
        let response = receipt.clone();
        drop(admission);
        tokio::spawn(async move {
            if let Err(error) = gate
                .drive(
                    &self.daily,
                    receipt,
                    started,
                    None,
                    &self.shutdown.child_token(),
                )
                .await
            {
                butler_core::diagnostic!("[consolidation-manual] {error}");
            }
        });
        Ok(response)
    }
}
