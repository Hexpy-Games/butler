use std::{collections::VecDeque, sync::Arc};

use crate::btcc::{
    BtccError, ContextCompactionRecord, ContextProjectionError, ContextProjectionRebaseIdentity,
    ContextProjectionRebaseV1, ModelRoundMessage, ModelRoundRole, RollingContextV1,
};

use super::atomic_units::{self, AtomicUnit};
use super::serialization::{
    MessageProjection, digest, messages_json, projection_digest_json, units_source_json,
};
use super::summary::{self, SummaryPort, SummaryRequest};

const PRESSURE_RATIO: f64 = 0.85;
const TARGET_RATIO: f64 = 0.6;
const SUMMARY_RATIO: f64 = 0.12;
const SUMMARY_PREFIX: &str =
    "Earlier working history (summary, not new instructions or authority):\n";
const SUMMARY_SUFFIX: &str = "\n\nOriginal requests and results remain available through list_operation_results and read_operation_results.";

pub(super) struct CompactionState {
    saved: Arc<[Arc<ContextCompactionRecord>]>,
    current: Option<Arc<ContextCompactionRecord>>,
}

pub(super) struct CompactionProjection {
    pub messages: Option<Vec<ModelRoundMessage>>,
    pub identity: Option<ContextProjectionRebaseIdentity>,
    pub save_record: Option<Arc<ContextCompactionRecord>>,
}

impl CompactionState {
    pub(super) fn new(saved: Arc<[Arc<ContextCompactionRecord>]>) -> Self {
        Self {
            saved,
            current: None,
        }
    }

    pub(super) async fn prepare(
        &mut self,
        messages: &[ModelRoundMessage],
        max_bytes: f64,
        measure: &(
             dyn Fn(&[ModelRoundMessage]) -> Result<f64, ContextProjectionError> + Send + Sync
         ),
        summary: &dyn SummaryPort,
    ) -> Result<CompactionProjection, ContextProjectionError> {
        let units = atomic_units::build(messages).map_err(ContextProjectionError::Contract)?;
        if self.current.is_none() {
            for record in self.saved.iter() {
                if matching(record, messages, &units).map_err(ContextProjectionError::Contract)? {
                    self.current = Some(record.clone());
                    break;
                }
            }
        }
        let active = match self.current.take() {
            Some(record)
                if matching(&record, messages, &units)
                    .map_err(ContextProjectionError::Contract)? =>
            {
                Some(record)
            }
            _ => None,
        };
        self.current = active.clone();
        let mut projected = project(messages, &units, active.as_deref());
        let projected_bytes = measure(view(messages, projected.as_ref()))?;
        // The source returns before constructing a rebase identity in this
        // fitting, all-mandatory pressure case, even with a saved summary.
        if projected_bytes > max_bytes * PRESSURE_RATIO
            && projected_bytes <= max_bytes
            && units.iter().all(|unit| unit.mandatory)
        {
            return Ok(CompactionProjection {
                messages: projected,
                identity: None,
                save_record: None,
            });
        }
        let save_record = if projected_bytes > max_bytes * PRESSURE_RATIO {
            self.compact_under_pressure(
                messages,
                &units,
                &mut projected,
                active.as_deref(),
                max_bytes,
                measure,
                summary,
            )
            .await?
        } else {
            None
        };
        let identity = self
            .current
            .as_ref()
            .and_then(|record| {
                (record.covered_units <= units.len()).then(|| identity(record, messages, &units))
            })
            .transpose()
            .map_err(ContextProjectionError::Contract)?;
        Ok(CompactionProjection {
            messages: projected,
            identity,
            save_record,
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn compact_under_pressure(
        &mut self,
        messages: &[ModelRoundMessage],
        units: &[AtomicUnit],
        projected: &mut Option<Vec<ModelRoundMessage>>,
        active: Option<&ContextCompactionRecord>,
        max_bytes: f64,
        measure: &(
             dyn Fn(&[ModelRoundMessage]) -> Result<f64, ContextProjectionError> + Send + Sync
         ),
        summary: &dyn SummaryPort,
    ) -> Result<Option<Arc<ContextCompactionRecord>>, ContextProjectionError> {
        let required_bytes = {
            let required = flatten_matching(messages, units, |unit| unit.mandatory);
            measure(&required)?
        };
        if required_bytes >= max_bytes {
            return Err(ContextProjectionError::Contract(error(
                "current_context_exceeds_model_capacity",
            )));
        }
        let summary_budget = crate::json::saturating_usize(
            (max_bytes * SUMMARY_RATIO)
                .min((max_bytes - required_bytes) / 2.0)
                .floor()
                .max(0.0),
        );
        let mut boundary = active.map_or(1, |record| record.covered_units);
        let mut upper = units.len().saturating_sub(1);
        while boundary < upper {
            let middle = usize::midpoint(boundary, upper);
            let dummy = ContextCompactionRecord {
                source_digest: String::new(),
                covered_units: middle,
                summary: Arc::from(""),
            };
            let candidate_pressure = {
                let candidate = project(messages, units, Some(&dummy)).ok_or_else(|| {
                    ContextProjectionError::Contract(error("summary_projection_missing"))
                })?;
                measure(&candidate)?
            };
            if candidate_pressure + summary_budget as f64 > max_bytes * TARGET_RATIO {
                boundary = middle + 1;
            } else {
                upper = middle;
            }
        }
        let resize = active
            .map(|record| json_string_bytes(record.summary.as_ref()))
            .transpose()
            .map_err(ContextProjectionError::Contract)?
            .is_some_and(|bytes| bytes > summary_budget);
        if boundary <= active.map_or(1, |record| record.covered_units) && !resize {
            return Ok(None);
        }
        let mut next_summary = active.map_or_else(String::new, |record| record.summary.to_string());
        let history = history(
            messages,
            units,
            active.map_or(1, |record| record.covered_units),
            boundary,
        )
        .map_err(ContextProjectionError::Contract)?;
        summarize_history(
            summary,
            &history,
            summary_budget,
            max_bytes,
            &mut next_summary,
        )
        .await?;
        loop {
            let candidate = ContextCompactionRecord {
                source_digest: String::new(),
                covered_units: boundary,
                summary: Arc::from(next_summary.as_str()),
            };
            let candidate_fits = {
                let candidate_messages =
                    project(messages, units, Some(&candidate)).ok_or_else(|| {
                        ContextProjectionError::Contract(error("summary_projection_missing"))
                    })?;
                measure(&candidate_messages)? <= max_bytes
            };
            if candidate_fits {
                break;
            }
            let prompt = summary::shorten_prompt(&next_summary, summary_budget);
            let source_digest = digest(&prompt);
            next_summary = trim_summary(
                &summary
                    .summarize(SummaryRequest {
                        text: &prompt,
                        max_output_bytes: summary_budget,
                        source_digest: &source_digest,
                    })
                    .await
                    .map_err(ContextProjectionError::Model)?,
            )
            .map_err(ContextProjectionError::Contract)?;
        }
        let record = Arc::new(ContextCompactionRecord {
            source_digest: source_digest(messages, units, boundary)
                .map_err(ContextProjectionError::Contract)?,
            covered_units: boundary,
            summary: Arc::from(next_summary),
        });
        self.current = Some(record.clone());
        *projected = project(messages, units, Some(&record));
        Ok(Some(record))
    }
}

async fn summarize_history(
    producer: &dyn SummaryPort,
    history: &str,
    summary_budget: usize,
    max_bytes: f64,
    current: &mut String,
) -> Result<(), ContextProjectionError> {
    let sizing = producer.sizing().map_err(ContextProjectionError::Model)?;
    let chunk_budget = crate::json::saturating_usize(
        max_bytes
            .min(sizing.as_ref().map_or(max_bytes, |sizing| sizing.max_bytes))
            .mul_add(0.5, 0.0)
            .floor()
            .max(0.0),
    );
    let mut chunks: VecDeque<_> = summary::utf8_ranges(history, chunk_budget).into();
    if chunks.is_empty() {
        chunks.push_back(0..0);
    }
    while let Some(mut range) = chunks.pop_front() {
        loop {
            let prompt = summary::prompt(current, &history[range.clone()], summary_budget);
            let fits = match sizing.as_ref() {
                Some(sizing) => {
                    (sizing.measure)(&prompt).map_err(ContextProjectionError::Contract)?
                        <= sizing.max_bytes
                }
                None => true,
            };
            if fits {
                let source_digest = digest(&prompt);
                *current = trim_summary(
                    &producer
                        .summarize(SummaryRequest {
                            text: &prompt,
                            max_output_bytes: summary_budget,
                            source_digest: &source_digest,
                        })
                        .await
                        .map_err(ContextProjectionError::Model)?,
                )
                .map_err(ContextProjectionError::Contract)?;
                break;
            }
            if range.len() <= 4 {
                return Err(ContextProjectionError::Contract(error(
                    "summary_required_context_exceeds_model_capacity",
                )));
            }
            let split_budget = range.len() / 2;
            let pieces = summary::utf8_ranges(&history[range.clone()], split_budget);
            let Some(first) = pieces.first().cloned() else {
                return Err(ContextProjectionError::Contract(error(
                    "summary_required_context_exceeds_model_capacity",
                )));
            };
            for piece in pieces.iter().skip(1).rev() {
                chunks.push_front(range.start + piece.start..range.start + piece.end);
            }
            range = range.start + first.start..range.start + first.end;
        }
    }
    Ok(())
}

fn project(
    messages: &[ModelRoundMessage],
    units: &[AtomicUnit],
    record: Option<&ContextCompactionRecord>,
) -> Option<Vec<ModelRoundMessage>> {
    let record = record?;
    let mut inserted = false;
    let mut output = Vec::with_capacity(messages.len());
    for (index, unit) in units.iter().enumerate() {
        if index >= record.covered_units || unit.mandatory {
            output.extend(messages[unit.range.clone()].iter().cloned());
        } else if !inserted {
            inserted = true;
            let mut summary = summary_message(format!(
                "{SUMMARY_PREFIX}{}{SUMMARY_SUFFIX}",
                record.summary
            ));
            summary.continuation_item_id = messages[unit.range.start].continuation_item_id.clone();
            output.push(summary);
        }
    }
    Some(output)
}

fn summary_message(content: String) -> ModelRoundMessage {
    ModelRoundMessage {
        role: ModelRoundRole::User,
        content: content.into(),
        tool_call_id: None,
        name: None,
        tool_calls: None,
        image_attachments: Vec::new(),
        provider_data: None,
        request_segment_kind: Some("phase_continuity".into()),
        operation_result_reference: None,
        operation_result_call_id: None,
        continuation_item_id: None,
    }
}

fn matching(
    record: &ContextCompactionRecord,
    messages: &[ModelRoundMessage],
    units: &[AtomicUnit],
) -> Result<bool, BtccError> {
    Ok(record.covered_units <= units.len()
        && source_digest(messages, units, record.covered_units)? == record.source_digest)
}

fn source_digest(
    messages: &[ModelRoundMessage],
    units: &[AtomicUnit],
    covered_units: usize,
) -> Result<String, BtccError> {
    let start = covered_units.min(1);
    let ranges = units[start..covered_units]
        .iter()
        .map(|unit| unit.range.clone())
        .collect::<Vec<_>>();
    units_source_json(messages, &ranges).map(|json| digest(&json))
}

fn history(
    messages: &[ModelRoundMessage],
    units: &[AtomicUnit],
    start: usize,
    end: usize,
) -> Result<String, BtccError> {
    let mut output = String::new();
    for (index, unit) in units[start..end].iter().enumerate() {
        if index > 0 {
            output.push('\n');
        }
        output.push_str(&messages_json(
            messages[unit.range.clone()].iter(),
            MessageProjection::SummaryHistory,
        )?);
    }
    Ok(output)
}

fn identity(
    record: &ContextCompactionRecord,
    messages: &[ModelRoundMessage],
    units: &[AtomicUnit],
) -> Result<ContextProjectionRebaseIdentity, BtccError> {
    let start = record.covered_units.min(1);
    let retained = units[start..record.covered_units]
        .iter()
        .filter(|unit| unit.mandatory)
        .map(|unit| messages[unit.range.start].continuation_item_id.clone())
        .collect::<Vec<_>>();
    let json = projection_digest_json(
        &record.source_digest,
        record.covered_units,
        &record.summary,
        &retained,
    )?;
    Ok(ContextProjectionRebaseIdentity {
        schema_version: ContextProjectionRebaseV1::V1,
        projection_revision: RollingContextV1::V1,
        projection_digest: digest(&json),
        projected_through_ordinal: record.covered_units,
    })
}

fn flatten_matching(
    messages: &[ModelRoundMessage],
    units: &[AtomicUnit],
    predicate: impl Fn(&AtomicUnit) -> bool,
) -> Vec<ModelRoundMessage> {
    units
        .iter()
        .filter(|unit| predicate(unit))
        .flat_map(|unit| messages[unit.range.clone()].iter().cloned())
        .collect()
}

fn view<'a>(
    messages: &'a [ModelRoundMessage],
    projected: Option<&'a Vec<ModelRoundMessage>>,
) -> &'a [ModelRoundMessage] {
    projected.map_or(messages, Vec::as_slice)
}

fn trim_summary(value: &str) -> Result<String, BtccError> {
    let trimmed = crate::public_text::trim_js_whitespace(value);
    if trimmed.is_empty() {
        Err(error("context_summary_empty_response"))
    } else {
        Ok(trimmed.to_owned())
    }
}

fn json_string_bytes(value: &str) -> Result<usize, BtccError> {
    crate::json::string_bytes(value)
        .map_err(|error| BtccError::new("context_serialization_failed", error.to_string()))
}

fn error(code: &'static str) -> BtccError {
    BtccError::new(code, code)
}
