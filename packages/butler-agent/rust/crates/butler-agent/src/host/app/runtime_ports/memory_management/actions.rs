use super::*;
impl AppMemoryManagement {
    pub(super) async fn cleanup_status(
        &self,
        id: String,
    ) -> Result<Value, GatewayApplicationError> {
        encode(
            self.owner
                .cleanup_status(id)
                .await
                .map_err(error)?
                .ok_or_else(|| {
                    public_error(404, "memory_operation_not_found", "Operation not found.")
                })?,
        )
    }

    pub(super) async fn project(
        &self,
        project_id: String,
        cancellation: CancellationToken,
    ) -> Result<Value, GatewayApplicationError> {
        let rows = self
            .instructions
            .list()
            .await
            .map_err(instructions::instruction_error)?;
        let count = rows
            .iter()
            .filter(|row| row.project_id.as_deref() == Some(&project_id))
            .count();
        let mut view = self
            .owner
            .project(project_id, cancellation)
            .await
            .map_err(error)?;
        view["instructions"] = json!(count);
        Ok(view)
    }
    pub(super) async fn start_cleanup(
        self,
        operation_id: String,
        inventory_revision: u64,
        sink: MemoryEventSink,
    ) -> Result<Value, GatewayApplicationError> {
        let gate = self.daily.gate.clone();
        let admission = gate.admission.lock().await;
        if gate.active().is_some() {
            return Err(error(std::io::Error::other("Memory is in use")));
        }
        let receipt = self
            .owner
            .begin_cleanup(operation_id.clone(), inventory_revision)
            .await
            .map_err(error)?;
        if ["complete", "cancelled", "failed"].contains(&receipt.phase.as_str()) {
            return encode(receipt);
        }
        let token = self.shutdown.child_token();
        {
            let mut jobs = self
                .jobs
                .lock()
                .map_err(|_| GatewayApplicationError::internal())?;
            if jobs.contains_key(&operation_id) {
                return encode(receipt);
            }
            jobs.insert(operation_id.clone(), token.clone());
        }
        drop(admission);
        tokio::spawn(self.drive(operation_id, inventory_revision, token, sink));
        encode(receipt)
    }
}
