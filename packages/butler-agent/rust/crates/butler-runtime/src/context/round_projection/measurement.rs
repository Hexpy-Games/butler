//! Reuse exact bytes already produced while measuring this immutable round.
use std::sync::OnceLock;

use butler_turn::btcc::{ContextProjectionError, ContextSizing, ModelRoundMessage, ModelRoundPort};

use super::serialization::{MessageProjection, messages_json};

pub(super) struct RoundMeasurement<'a> {
    model: &'a dyn ModelRoundPort,
    sizing: Option<ContextSizing<'a>>,
    original: &'a [ModelRoundMessage],
    original_bytes: OnceLock<usize>,
    data: Option<&'a str>,
    limit: usize,
}

impl<'a> RoundMeasurement<'a> {
    pub(super) fn new(
        model: &'a dyn ModelRoundPort,
        sizing: Option<ContextSizing<'a>>,
        original: &'a [ModelRoundMessage],
        data: Option<&'a str>,
        limit: usize,
    ) -> Self {
        Self {
            model,
            sizing,
            original,
            original_bytes: OnceLock::new(),
            data,
            limit,
        }
    }

    pub(super) fn bytes(
        &self,
        messages: &[ModelRoundMessage],
    ) -> Result<usize, ContextProjectionError> {
        if std::ptr::eq(messages, self.original)
            && let Some(bytes) = self.original_bytes.get()
        {
            return Ok(*bytes);
        }
        self.model
            .stateless_message_bytes(messages, self.data)
            .map_err(ContextProjectionError::Model)?
            .map_or_else(
                || {
                    messages_json(messages.iter(), MessageProjection::Exact)
                        .map_err(ContextProjectionError::Contract)
                        .map(|json| json.len())
                },
                Ok,
            )
    }

    pub(super) fn pressure(
        &self,
        messages: &[ModelRoundMessage],
    ) -> Result<f64, ContextProjectionError> {
        let (bytes, pressure) = match &self.sizing {
            Some(sizing) => {
                let measured =
                    (sizing.measure)(messages).map_err(ContextProjectionError::Contract)?;
                let bytes = match measured.stateless_bytes {
                    Some(bytes) => bytes,
                    None => self.bytes(messages)?,
                };
                (
                    bytes,
                    measured.pressure_bytes * self.limit as f64 / sizing.max_message_bytes,
                )
            }
            None => (self.bytes(messages)?, 0.0),
        };
        // The original slice stays borrowed and immutable for this whole round.
        // Temporary compaction slices can reuse addresses, so never cache those.
        if std::ptr::eq(messages, self.original) {
            let _ = self.original_bytes.set(bytes);
        }
        Ok((bytes as f64).max(pressure))
    }
}
