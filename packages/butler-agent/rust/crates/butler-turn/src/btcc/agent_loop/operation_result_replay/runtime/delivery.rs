//! Delivery of replayed operation results and the runtime's error mapping.

use super::*;

/// What a transcript replay borrows for the round being prepared.
pub(super) struct Replay<'a> {
    pub(super) round_id: &'a str,
    pub(super) model: &'a dyn ModelRoundPort,
    pub(super) butler_data: Option<&'a str>,
}

/// Delivery states of a durable tool result in the journal.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum DeliveryState {
    PendingDelivery,
    InFlight,
    Acknowledged,
    ReferenceOnly,
    Unknown,
}

impl DeliveryState {
    pub(super) fn parse(value: Option<&str>) -> Option<Self> {
        Some(match value? {
            "pending_delivery" => Self::PendingDelivery,
            "in_flight" => Self::InFlight,
            "acknowledged" => Self::Acknowledged,
            "reference_only" => Self::ReferenceOnly,
            _ => Self::Unknown,
        })
    }
}

impl OperationResultReplayRuntime {
    /// The reference projection of an older durable tool result, when its
    /// delivery lets this round replace it: pending results start delivery
    /// in this round, in-flight ones stay until acknowledged.
    pub(super) async fn project_tool_result(
        &self,
        message: &ModelRoundMessage,
        replay: &Replay<'_>,
    ) -> Result<Option<ModelRoundMessage>, OperationResultError> {
        let Some(call_id) = message.tool_call_id.as_deref() else {
            return Ok(None);
        };
        if message.role != ModelRoundRole::Tool || call_id.is_empty() {
            return Ok(None);
        }
        let lookup = message
            .operation_result_call_id
            .as_deref()
            .unwrap_or(call_id);
        let Some(mut record) = self.record(lookup).await? else {
            return Ok(None);
        };
        if !durable(&record) {
            return Ok(None);
        }
        let result_reference = self.reference_for(&record).await?;
        let value = serde_json::to_value(&result_reference).map_err(|source| {
            OperationResultError::Contract(
                contract(BtccCode::OperationResultSerializationFailed).with_source(source),
            )
        })?;
        let content =
            crate::btcc::identity::stable_json(&value).map_err(OperationResultError::Contract)?;
        let mut candidate = message.clone();
        candidate.content = content.into();
        candidate.request_segment_kind = Some("older_tool_result_projection".into());
        if record.delivery_state.is_none() {
            if !self.replacement_saves(message, &candidate, replay.model, replay.butler_data)? {
                return Ok(None);
            }
            self.journal
                .admit_delivery(self.scope.turn_id.clone(), record.call_id.clone())
                .await
                .map_err(storage)?;
            record = self.record(&record.call_id).await?.ok_or_else(|| {
                OperationResultError::Contract(contract(
                    BtccCode::OperationResultDeliveryAdmissionFailed,
                ))
            })?;
        }
        match DeliveryState::parse(record.delivery_state.as_deref()) {
            Some(DeliveryState::PendingDelivery) => {
                self.journal
                    .begin_delivery(
                        self.scope.turn_id.clone(),
                        record.call_id,
                        replay.round_id.into(),
                    )
                    .await
                    .map_err(storage)?;
                return Ok(None);
            }
            Some(DeliveryState::InFlight)
                if record.delivery_round_id.as_deref() == Some(replay.round_id) =>
            {
                return Ok(None);
            }
            Some(DeliveryState::InFlight) => {
                return Err(OperationResultError::Contract(contract(
                    BtccCode::OperationResultDeliveryInFlightMismatch,
                )));
            }
            Some(DeliveryState::Acknowledged) => self
                .journal
                .promote_acknowledged(self.scope.turn_id.clone(), record.call_id)
                .await
                .map_err(storage)?,
            Some(DeliveryState::ReferenceOnly) => {}
            Some(DeliveryState::Unknown) | None => return Ok(None),
        }
        candidate.operation_result_reference = Some(result_reference);
        Ok(Some(candidate))
    }
}

pub(super) fn durable(record: &ToolJournalRecord) -> bool {
    record.status == "completed"
        && record.result.is_some()
        && !READERS.contains(&record.tool_name.as_str())
}

pub(super) fn storage(error: StorageError) -> OperationResultError {
    OperationResultError::Contract(BtccError::from(error))
}
pub(super) fn contract_error(error: OperationResultError) -> BtccError {
    match error {
        OperationResultError::Contract(error) => error,
        OperationResultError::Model(_) => {
            contract(BtccCode::OperationResultModelMeasurementUnexpected)
        }
    }
}
pub(super) fn contract(code: BtccCode) -> BtccError {
    BtccError::detected(code, code.as_str())
}

pub(super) fn numeric_argument_error(error: butler_core::json::JsonError) -> BtccError {
    BtccError::detected(
        BtccCode::OperationResultArgumentCoercionFailed,
        error.to_string(),
    )
    .with_source(error)
}

/// A numeric tool argument; absent and `null` read as none.
// Passthrough: tool arguments/results/schemas, shaped by each tool.
pub(super) fn optional_number(
    // Passthrough: tool arguments/results/schemas, shaped by each tool.
    args: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<Option<f64>, BtccError> {
    args.get(key)
        .filter(|value| !value.is_null())
        .map(butler_core::json::coerce_number)
        .transpose()
        .map_err(numeric_argument_error)
}
