use super::*;

impl OperationResultReplayRuntime {
    pub(super) async fn list(&self, args: &Map<String, Value>) -> Result<Value, BtccError> {
        let cursor = optional_number(args, "cursor")?.unwrap_or(0.0);
        let through = optional_number(args, "through")?;
        let limit = optional_number(args, "limit")?
            .unwrap_or(5.0)
            .clamp(1.0, 10.0);
        let page = self
            .results
            .discover(OperationResultDiscoveryInput {
                evidence: args
                    .get("evidence")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                turn_id: self.scope.turn_id.clone(),
                work_id: self.scope.work_id.clone(),
                cursor,
                through,
                query: args
                    .get("query")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .into(),
                tool_name: args
                    .get("tool_name")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                status: args
                    .get("status")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                limit,
            })
            .await
            .map_err(BtccError::from)?;
        let entries = self.list_entries(page.entries, args).await?;
        serde_json::to_value(OperationResultListOutput {
            through: page.through,
            next_cursor: page.next_cursor,
            entries,
        })
        .map_err(|source| {
            contract(BtccCode::OperationResultSerializationFailed).with_source(source)
        })
    }

    async fn list_entries(
        &self,
        page_entries: Vec<crate::btcc::storage::OperationResultDiscoveryEntry>,
        args: &Map<String, Value>,
    ) -> Result<Vec<OperationResultListEntry>, BtccError> {
        let mut entries = Vec::with_capacity(page_entries.len());
        for entry in page_entries {
            let stored = self
                .results
                .resolve_result_reference(OperationResultReferenceInput {
                    turn_id: entry.origin_turn_id,
                    call_id: entry.call_id,
                })
                .await
                .map_err(BtccError::from)?;
            entries.push(OperationResultListEntry {
                tool_name: entry.tool_name,
                status: entry.status,
                started_at: entry.started_at,
                request_preview: entry.request_preview,
                exact_read: ExactReadArgumentsWire {
                    evidence: args
                        .get("evidence")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    result_ref: stored.result_ref,
                    sha256: entry.result_sha256,
                    revision: stored.revision,
                    work_id: stored.work_id,
                    offset: 0,
                    length: MAX_EXACT_READ_BYTES,
                },
            });
        }
        Ok(entries)
    }
}
