//! Budgeted provider-history rewrites; journaled tool results remain complete.
use super::{ModelRoundMessage, ModelRoundRole, field, plan, strip_desktop_stills};
use serde_json::Value;
use std::sync::Arc;

/// Request-end cache simulation saved 52–56% at 16k stale tokens. The byte
/// guard reserves at most 25% of the context for stale content, below the 85%
/// compaction trigger. 1,600 tokens covers provider charges for a 1280×800 JPEG.
const STALE_PRUNE_TOKENS: usize = 16_000;
const IMAGE_TOKENS: usize = 1_600;

#[derive(Default)]
pub(in crate::btcc::agent_loop) struct BrowserPrune {
    /// Message count at the last applied prune; zero means none.
    pub watermark: usize,
    /// Messages already scanned for still files in this execution.
    pub stripped: usize,
}

pub(super) struct Stale {
    pub index: usize,
    pub stub: Arc<str>,
    pub tokens: usize,
    pub bytes: usize,
}

impl Stale {
    pub(super) fn new(index: usize, message: &ModelRoundMessage, stub: Arc<str>) -> Self {
        let value = serde_json::from_str::<Value>(&message.content).unwrap_or(Value::Null);
        let image = field(field(&value, "output"), "image");
        let data = (image["mime_type"] == "image/jpeg")
            .then(|| image["data"].as_str())
            .flatten();
        let bytes = message.content.len();
        let tokens = bytes.saturating_sub(data.map_or(0, str::len)).div_ceil(4)
            + if data.is_some() { IMAGE_TOKENS } else { 0 };
        Self {
            index,
            stub,
            tokens,
            bytes,
        }
    }
}

pub(in crate::btcc::agent_loop) fn prune(
    messages: &mut [ModelRoundMessage],
    prune: &mut BrowserPrune,
    floor: usize,
    byte_limit: u64,
) {
    // Earlier messages were scanned already; later stubs cannot add still files.
    let len = messages.len();
    if let Some(unscanned) = messages.get_mut(prune.stripped.min(len)..) {
        strip_stills(unscanned);
    }
    prune.stripped = len;
    let stale: Vec<_> = plan(messages)
        .into_iter()
        .filter(|s| s.index >= floor)
        .collect();
    let bytes = usize::try_from(byte_limit).unwrap_or(usize::MAX);
    if within(stale.iter(), STALE_PRUNE_TOKENS, bytes / 4) {
        return;
    }
    let frozen = stale.iter().filter(|s| s.index < prune.watermark);
    let start = if within(frozen, STALE_PRUNE_TOKENS / 2, bytes / 8) {
        prune.watermark.max(floor)
    } else {
        floor
    };
    for stale in stale.into_iter().filter(|s| s.index >= start) {
        if let Some(message) = messages.get_mut(stale.index) {
            message.content = stale.stub;
            message.image_attachments.clear();
        }
    }
    prune.watermark = messages.len();
}

fn within<'a>(stale: impl Iterator<Item = &'a Stale>, tokens: usize, bytes: usize) -> bool {
    let (total_tokens, total_bytes) = stale.fold((0usize, 0usize), |(tokens, bytes), s| {
        (
            tokens.saturating_add(s.tokens),
            bytes.saturating_add(s.bytes),
        )
    });
    total_tokens <= tokens && total_bytes <= bytes
}

fn strip_stills(messages: &mut [ModelRoundMessage]) {
    for message in messages {
        if message.role != ModelRoundRole::Tool || !message.content.contains("still_file") {
            continue;
        }
        let Ok(mut value) = serde_json::from_str::<Value>(&message.content) else {
            continue;
        };
        let Some(output) = value.get_mut("output") else {
            continue;
        };
        if matches!(
            output["schema"].as_str(),
            Some("butler.browser-action.v1" | "butler.browser-observation.v1")
        ) && strip_desktop_stills(output)
        {
            message.content = value.to_string().into();
        }
    }
}
