//! Per-turn private draft parsing with the same evidence owners as final acceptance.
use super::GuidedTools;
use butler_core::tool_protocol::ToolCallStreamEvent;
use butler_runtime::capabilities::answer_blocks::{self, AnswerBlocksContext, AnswerBlocksParser};
use butler_turn::btcc::{AgentLoopProgress, AnswerBlocksStreamPort, PortFuture};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};

struct Call {
    call_id: Option<String>,
    parser: AnswerBlocksParser,
    sources: Vec<String>,
    images: std::collections::HashSet<String>,
}

pub(in crate::host::guided) struct AnswerBlocksStream {
    tools: Arc<GuidedTools>,
    calls: Mutex<HashMap<(String, u64), Call>>,
}

impl AnswerBlocksStream {
    pub(in crate::host::guided) fn relay(
        tools: Arc<GuidedTools>,
    ) -> butler_turn::btcc::StreamRelay {
        butler_turn::btcc::StreamRelay::new().with_answer_blocks(Arc::new(Self {
            tools,
            calls: Mutex::default(),
        }))
    }

    async fn delta(
        &self,
        stream_id: String,
        index: u64,
        delta: String,
        progress: &dyn AgentLoopProgress,
    ) -> Result<(), butler_turn::btcc::BtccError> {
        let key = (stream_id.clone(), index);
        // The relay serializes calls; move state out before awaiting evidence I/O.
        let Some(mut call) = self.calls.lock().remove(&key) else {
            return Ok(());
        };
        let mut units = call.parser.push(delta.as_bytes());
        for unit in &mut units {
            if let Some(value) = &mut unit.value {
                answer_blocks::normalize_unit(value);
            }
        }
        let values: Vec<_> = units
            .iter()
            .filter_map(|unit| {
                unit.value.as_ref().map(|value| {
                    if unit.index.is_none() && unit.field.as_deref() == Some("source") {
                        json!({"source": value})
                    } else {
                        value.clone()
                    }
                })
            })
            .collect();
        let candidates = answer_blocks::sources(&json!(values));
        if !candidates.is_empty() {
            let sources = self
                .tools
                .journal
                .read_sources(self.tools.binding.source_session_id.clone(), candidates)
                .await?;
            for source in sources {
                if !call.sources.contains(&source) {
                    call.sources.push(source);
                }
            }
        }
        let ids = answer_blocks::image_ids(&json!(values));
        if !ids.is_empty() {
            call.images
                .extend(super::browser::lookup_assets(&self.tools, ids).await);
        }
        let call_id = call.call_id.clone();
        let ops: Vec<Value> = {
            let context = AnswerBlocksContext {
                now: chrono::Utc::now(),
                image_exists: &|id| call.images.contains(id),
                read_sources: &call.sources,
            };
            units
                .into_iter()
                .flat_map(|unit| call.parser.apply(unit, &context))
                .filter_map(|op| serde_json::to_value(op).ok())
                .collect()
        };
        self.calls.lock().insert(key, call);
        if !ops.is_empty() {
            progress
                .answer_blocks_draft(stream_id, index, call_id, ops)
                .await?;
        }
        Ok(())
    }
}

impl AnswerBlocksStreamPort for AnswerBlocksStream {
    fn tool_call<'a>(
        &'a self,
        event: ToolCallStreamEvent,
        progress: &'a dyn AgentLoopProgress,
    ) -> PortFuture<'a, ()> {
        Box::pin(async move {
            match event {
                ToolCallStreamEvent::ToolCallStart {
                    stream_id,
                    call_index,
                    call_id,
                    ..
                } => {
                    self.calls.lock().insert(
                        (stream_id, call_index),
                        Call {
                            call_id,
                            parser: AnswerBlocksParser::default(),
                            sources: Vec::new(),
                            images: Default::default(),
                        },
                    );
                    Ok(())
                }
                ToolCallStreamEvent::ToolCallDelta {
                    stream_id,
                    call_index,
                    arguments_delta,
                    ..
                } => {
                    self.delta(stream_id, call_index, arguments_delta, progress)
                        .await
                }
            }
        })
    }

    fn clear(&self) {
        self.calls.lock().clear();
    }
}
