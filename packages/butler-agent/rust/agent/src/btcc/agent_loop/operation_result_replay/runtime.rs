use std::sync::Arc;

use serde_json::{Map, Value, json};

use crate::btcc::storage::{
    ExactResultRangeInput, ExactResultSource as StoredSource, OperationResultDiscoveryInput,
    OperationResultReferenceInput, OperationResultRepository, StorageError, ToolJournalRecord,
    ToolJournalRepository,
};
use crate::btcc::{BtccError, PortFuture};

use super::super::contracts::{
    ModelRoundMessage, ModelRoundResult, ModelRoundRole, ReplayPreparation,
};
use super::super::ports::ModelRoundPort;
use super::arguments::{MAX_EXACT_READ_BYTES, exact_read_arguments};
use super::contracts::*;
use super::reference::reference;

const READERS: &[&str] = &[
    "list_operation_results",
    "read_operation_results",
    "read_tool_output_artifact",
    "read_tool_evidence_artifact",
];

pub(crate) struct OperationResultReplayFactory {
    selection: ExactResultReplaySelection,
    journal: Arc<ToolJournalRepository>,
    results: Arc<OperationResultRepository>,
}

impl OperationResultReplayFactory {
    pub(crate) fn new(
        selection: ExactResultReplaySelection,
        journal: Arc<ToolJournalRepository>,
        results: Arc<OperationResultRepository>,
    ) -> Self {
        Self {
            selection,
            journal,
            results,
        }
    }
}

impl OperationResultRuntimeFactory for OperationResultReplayFactory {
    fn bind(
        &self,
        scope: OperationResultScope,
    ) -> Result<Option<Arc<dyn OperationResultRuntime>>, BtccError> {
        if self.selection.mode == ReplayMode::Disabled && !self.selection.exact_read_capability {
            return Ok(None);
        }
        if !self.selection.exact_read_capability {
            return Err(contract("operation_result_exact_read_dependency_missing"));
        }
        Ok(Some(Arc::new(OperationResultReplayRuntime {
            scope,
            selection: self.selection,
            journal: self.journal.clone(),
            results: self.results.clone(),
        })))
    }
}

pub(crate) struct OperationResultReplayRuntime {
    scope: OperationResultScope,
    selection: ExactResultReplaySelection,
    journal: Arc<ToolJournalRepository>,
    results: Arc<OperationResultRepository>,
}

impl OperationResultReplayRuntime {
    async fn record(
        &self,
        call_id: &str,
    ) -> Result<Option<ToolJournalRecord>, OperationResultError> {
        self.journal
            .find_for_turn(self.scope.turn_id.clone(), call_id.to_owned())
            .await
            .map_err(storage)
    }

    async fn reference_for(
        &self,
        record: &ToolJournalRecord,
    ) -> Result<OperationResultReference, OperationResultError> {
        let stored = self
            .results
            .resolve_result_reference(OperationResultReferenceInput {
                turn_id: self.scope.turn_id.clone(),
                call_id: record.call_id.clone(),
            })
            .await
            .map_err(storage)?;
        reference(record, stored, self.selection.exact_read_capability)
            .map_err(OperationResultError::Contract)
    }

    async fn replacement_saves(
        &self,
        original: &ModelRoundMessage,
        replacement: &ModelRoundMessage,
        model: &dyn ModelRoundPort,
        butler_data: Option<&str>,
    ) -> Result<bool, OperationResultError> {
        if let Some(replacement_bytes) = model
            .stateless_message_bytes(std::slice::from_ref(replacement), butler_data)
            .map_err(OperationResultError::Model)?
        {
            let original_bytes = model
                .stateless_message_bytes(std::slice::from_ref(original), butler_data)
                .map_err(OperationResultError::Model)?
                .ok_or_else(|| {
                    OperationResultError::Contract(contract(
                        "operation_result_message_measurement_missing",
                    ))
                })?;
            return Ok(replacement_bytes < original_bytes);
        }
        let replacement_bytes =
            crate::json::string_bytes(&replacement.content).map_err(|error| {
                OperationResultError::Contract(BtccError::new(
                    "operation_result_serialization_failed",
                    error.to_string(),
                ))
            })?;
        let original_bytes = crate::json::string_bytes(&original.content).map_err(|error| {
            OperationResultError::Contract(BtccError::new(
                "operation_result_serialization_failed",
                error.to_string(),
            ))
        })?;
        Ok(replacement_bytes < original_bytes)
    }

    async fn read(&self, arguments: ExactReadArguments) -> Result<Value, BtccError> {
        let direct = self
            .journal
            .find_for_turn(self.scope.turn_id.clone(), arguments.result_ref.clone())
            .await
            .map_err(btcc)?;
        if direct.is_some() && arguments.revision.is_some() {
            return Err(contract("operation_result_revision_mismatch"));
        }
        let result = self
            .results
            .read_exact_result_range(ExactResultRangeInput {
                turn_id: self.scope.turn_id.clone(),
                result_ref: arguments.result_ref,
                result_sha256: arguments.sha256,
                revision: direct.is_none().then_some(arguments.revision).flatten(),
                session_id: Some(self.scope.session_id.clone()),
                project_ref: self.scope.project_ref.clone(),
                work_id: arguments.work_id,
                offset: arguments.offset,
                length: arguments.length,
                source: match arguments.source {
                    ExactReadSource::Request => StoredSource::Request,
                    ExactReadSource::Result => StoredSource::Result,
                },
            })
            .await
            .map_err(btcc)?;
        Ok(json!({
            "encoding": result.encoding,
            "data": result.data,
            "offset": result.offset,
            "length": result.length,
            "total_bytes": result.total_bytes,
            "next_offset": result.next_offset,
            "result_sha256": result.result_sha256,
            "complete": result.complete,
        }))
    }
}

impl OperationResultRuntime for OperationResultReplayRuntime {
    fn prepare<'a>(
        &'a self,
        round_id: &'a str,
        messages: &'a [ModelRoundMessage],
        model: &'a dyn ModelRoundPort,
        butler_data: Option<&'a str>,
    ) -> OperationResultFuture<'a, ReplayPreparation> {
        Box::pin(async move {
            if self.selection.mode == ReplayMode::Disabled {
                return Ok(ReplayPreparation { messages: None });
            }
            let anchors = super::anchors::latest_work_anchor_indices(messages);
            let mut projected: Option<Vec<ModelRoundMessage>> = None;
            for (index, message) in messages.iter().enumerate() {
                let Some(call_id) = message.tool_call_id.as_deref() else {
                    continue;
                };
                if message.role != ModelRoundRole::Tool
                    || call_id.is_empty()
                    || anchors.contains(&index)
                {
                    continue;
                }
                let lookup = message
                    .operation_result_call_id
                    .as_deref()
                    .unwrap_or(call_id);
                let Some(mut record) = self.record(lookup).await? else {
                    continue;
                };
                if !durable(&record) {
                    continue;
                }
                let result_reference = self.reference_for(&record).await?;
                let value = serde_json::to_value(&result_reference).map_err(|_| {
                    OperationResultError::Contract(contract(
                        "operation_result_serialization_failed",
                    ))
                })?;
                let content = crate::btcc::identity::stable_json(&value)
                    .map_err(OperationResultError::Contract)?;
                let mut candidate = message.clone();
                candidate.content = content.into();
                candidate.request_segment_kind = Some("older_tool_result_projection".into());
                if record.delivery_state.is_none() {
                    if !self
                        .replacement_saves(message, &candidate, model, butler_data)
                        .await?
                    {
                        continue;
                    }
                    self.journal
                        .admit_delivery(self.scope.turn_id.clone(), record.call_id.clone())
                        .await
                        .map_err(storage)?;
                    record = self.record(&record.call_id).await?.ok_or_else(|| {
                        OperationResultError::Contract(contract(
                            "operation_result_delivery_admission_failed",
                        ))
                    })?;
                }
                match record.delivery_state.as_deref() {
                    Some("pending_delivery") => {
                        self.journal
                            .begin_delivery(
                                self.scope.turn_id.clone(),
                                record.call_id,
                                round_id.into(),
                            )
                            .await
                            .map_err(storage)?;
                        continue;
                    }
                    Some("in_flight") if record.delivery_round_id.as_deref() == Some(round_id) => {
                        continue;
                    }
                    Some("in_flight") => {
                        return Err(OperationResultError::Contract(contract(
                            "operation_result_delivery_in_flight_mismatch",
                        )));
                    }
                    Some("acknowledged") => self
                        .journal
                        .promote_acknowledged(self.scope.turn_id.clone(), record.call_id)
                        .await
                        .map_err(storage)?,
                    Some("reference_only") => {}
                    _ => continue,
                }
                let target = projected.get_or_insert_with(|| messages.to_vec());
                candidate.operation_result_reference = Some(result_reference);
                target[index] = candidate;
            }
            Ok(ReplayPreparation {
                messages: projected,
            })
        })
    }

    fn accepted<'a>(
        &'a self,
        round_id: &'a str,
        result: &'a ModelRoundResult,
    ) -> OperationResultFuture<'a, ()> {
        Box::pin(async move {
            if self.selection.mode == ReplayMode::Disabled {
                return Ok(());
            }
            if result
                .accepted_checkpoint
                .as_ref()
                .map(|value| value.round_id.as_str())
                != Some(round_id)
            {
                return Err(OperationResultError::Contract(contract(
                    "operation_result_route_acceptance_missing",
                )));
            }
            let calls: Vec<_> = result
                .tool_calls
                .iter()
                .map(
                    |call| json!({"id":call.id,"name":call.name,"rawArguments":call.raw_arguments}),
                )
                .collect();
            let body = json!({"text":result.text.as_deref().unwrap_or(""),"calls":calls});
            let hash = crate::btcc::identity::digest(
                &crate::btcc::identity::stable_json(&body)
                    .map_err(OperationResultError::Contract)?,
            );
            self.journal
                .acknowledge_deliveries(self.scope.turn_id.clone(), round_id.into(), hash)
                .await
                .map_err(storage)
        })
    }

    fn failed<'a>(&'a self, round_id: &'a str) -> OperationResultFuture<'a, ()> {
        Box::pin(async move {
            if self.selection.mode == ReplayMode::Disabled {
                return Ok(());
            }
            self.journal
                .release_deliveries(self.scope.turn_id.clone(), round_id.into())
                .await
                .map_err(storage)
        })
    }

    fn read_tool<'a>(&'a self, args: &'a Map<String, Value>) -> PortFuture<'a, Value> {
        Box::pin(async move {
            if !self.selection.exact_read_capability {
                return Err(contract("operation_result_exact_read_unavailable"));
            }
            self.read(exact_read_arguments(args)?).await
        })
    }

    fn list_tool<'a>(&'a self, args: &'a Map<String, Value>) -> PortFuture<'a, Value> {
        Box::pin(async move {
            let cursor = args
                .get("cursor")
                .filter(|value| !value.is_null())
                .map(crate::json::coerce_number)
                .transpose()
                .map_err(numeric_argument_error)?
                .unwrap_or(0.0);
            let through = args
                .get("through")
                .filter(|value| !value.is_null())
                .map(crate::json::coerce_number)
                .transpose()
                .map_err(numeric_argument_error)?;
            let limit = args
                .get("limit")
                .filter(|value| !value.is_null())
                .map(crate::json::coerce_number)
                .transpose()
                .map_err(numeric_argument_error)?
                .unwrap_or(5.0)
                .clamp(1.0, 10.0);
            let page = self
                .results
                .discover(OperationResultDiscoveryInput {
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
                .map_err(btcc)?;
            let mut entries = Vec::with_capacity(page.entries.len());
            for entry in page.entries {
                let stored = self
                    .results
                    .resolve_result_reference(OperationResultReferenceInput {
                        turn_id: entry.origin_turn_id,
                        call_id: entry.call_id,
                    })
                    .await
                    .map_err(btcc)?;
                entries.push(OperationResultListEntry {
                    tool_name: entry.tool_name,
                    status: entry.status,
                    started_at: entry.started_at,
                    request_preview: entry.request_preview,
                    exact_read: ExactReadArgumentsWire {
                        result_ref: stored.result_ref,
                        sha256: entry.result_sha256,
                        revision: stored.revision,
                        work_id: stored.work_id,
                        offset: 0,
                        length: MAX_EXACT_READ_BYTES,
                    },
                });
            }
            serde_json::to_value(OperationResultListOutput {
                through: page.through,
                next_cursor: page.next_cursor,
                entries,
            })
            .map_err(|_| contract("operation_result_serialization_failed"))
        })
    }

    fn references_for_call<'a>(
        &'a self,
        provider_tool_name: &'a str,
        journal_call_id: Option<&'a str>,
    ) -> PortFuture<'a, OperationResultMessageReferences> {
        Box::pin(async move {
            let Some(call_id) = journal_call_id.filter(|value| !value.is_empty()) else {
                return Ok(Default::default());
            };
            let Some(record) = self.record(call_id).await.map_err(contract_error)? else {
                return Ok(Default::default());
            };
            if !durable(&record) {
                return Ok(OperationResultMessageReferences {
                    operation_result_call_id: Some(call_id.into()),
                    ..Default::default()
                });
            }
            let reference = self.reference_for(&record).await.map_err(contract_error)?;
            let exact_read = if provider_tool_name != "read_operation_results"
                && self.selection.exact_read_capability
            {
                let result = record.result.as_ref().expect("durable record has result");
                let total_bytes = result.as_str().len();
                Some(ToolResultExactReadReference {
                    capability: ReadOperationResultsOnly::ReadOperationResults,
                    arguments: ExactReadArgumentsWire {
                        result_ref: reference.identity.result_ref.clone(),
                        sha256: reference.integrity.sha256.clone(),
                        revision: reference.integrity.revision,
                        work_id: reference.identity.work_id.clone(),
                        offset: 0,
                        length: total_bytes.min(MAX_EXACT_READ_BYTES),
                    },
                    total_bytes,
                })
            } else {
                None
            };
            Ok(OperationResultMessageReferences {
                operation_result_call_id: Some(call_id.into()),
                reference: Some(reference),
                exact_read,
            })
        })
    }
}

fn durable(record: &ToolJournalRecord) -> bool {
    record.status == "completed"
        && record.result.is_some()
        && record.result_sha256.is_some()
        && !READERS.contains(&record.tool_name.as_str())
}

fn storage(error: StorageError) -> OperationResultError {
    OperationResultError::Contract(btcc(error))
}
fn contract_error(error: OperationResultError) -> BtccError {
    match error {
        OperationResultError::Contract(error) => error,
        OperationResultError::Model(_) => contract("operation_result_model_measurement_unexpected"),
    }
}
fn btcc(error: StorageError) -> BtccError {
    BtccError::new(error.code, error.message)
}
fn contract(code: &'static str) -> BtccError {
    BtccError::new(code, code)
}

fn numeric_argument_error(error: crate::json::JsonError) -> BtccError {
    BtccError::new(
        "operation_result_argument_coercion_failed",
        error.to_string(),
    )
}
