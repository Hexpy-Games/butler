//! Budgeted provider-history rewrites; journaled tool results remain complete.
use super::{ModelRoundMessage, ModelRoundRole, field, plan, strip_desktop_stills};
use serde_json::Value;
use std::sync::Arc;

/// A rewrite of already-sent history makes the provider re-read it uncached;
/// on the purchase-replay data (2026-10-23) Gemini then reused only the tools
/// and system prefix. Stale results are therefore stubbed only when the
/// expected saving pays for losing the whole cached history, or when the
/// history nears the context budget (compaction starts at 85%).
const MIN_STALE_TOKENS: usize = 4_000;
const PRESSURE_RATIO: f64 = 0.6;
/// Cached/uncached price ratio assumed when the catalog publishes no price
/// (subscription routes); the common published ratio.
const UNPRICED_CACHED_RATIO: f64 = 0.1;
/// 1,600 tokens covers provider charges for a 1280×800 JPEG.
const IMAGE_TOKENS: usize = 1_600;

#[derive(Default)]
pub(in crate::btcc::agent_loop) struct BrowserPrune {
    /// Message count at the last applied prune; zero means none.
    pub watermark: usize,
    /// Messages already scanned for still files in this execution.
    pub stripped: usize,
}

/// What a rewrite of sent history costs and saves for this model.
pub(in crate::btcc::agent_loop) struct PruneEconomy {
    /// Model-facing byte budget of the context.
    pub byte_limit: u64,
    /// Catalog cached/uncached input price ratio, when published.
    pub cached_ratio: Option<f64>,
    /// Model requests already sent in this execution.
    pub rounds_sent: u32,
}

pub(super) struct Stale {
    pub index: usize,
    pub stub: Arc<str>,
    pub tokens: usize,
    pub bytes: usize,
}

impl Stale {
    pub(super) fn new(index: usize, message: &ModelRoundMessage, stub: Arc<str>) -> Self {
        Self {
            index,
            stub,
            tokens: estimate_tokens(&message.content),
            bytes: message.content.len(),
        }
    }

    fn saving(&self) -> usize {
        self.tokens.saturating_sub(self.stub.len().div_ceil(4))
    }
}

/// Estimated provider tokens of one message: text at 4 bytes per token, an
/// inline JPEG at its image charge instead of its base64 length.
fn estimate_tokens(content: &str) -> usize {
    if !content.contains("image/jpeg") {
        return content.len().div_ceil(4);
    }
    let value = serde_json::from_str::<Value>(content).unwrap_or(Value::Null);
    let image = field(field(&value, "output"), "image");
    let data = (image["mime_type"] == "image/jpeg")
        .then(|| image["data"].as_str())
        .flatten();
    content
        .len()
        .saturating_sub(data.map_or(0, str::len))
        .div_ceil(4)
        + if data.is_some() { IMAGE_TOKENS } else { 0 }
}

pub(in crate::btcc::agent_loop) fn prune(
    messages: &mut [ModelRoundMessage],
    prune: &mut BrowserPrune,
    floor: usize,
    economy: &PruneEconomy,
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
    let saving = stale.iter().map(Stale::saving).sum::<usize>();
    if saving == 0 {
        return;
    }
    let history = messages
        .iter()
        .map(|message| estimate_tokens(&message.content))
        .sum::<usize>();
    let stale_bytes = stale.iter().map(|s| s.bytes).sum::<usize>();
    if !worth_rewriting(saving, (history, stale_bytes), economy) {
        return;
    }
    for stale in stale {
        if let Some(message) = messages.get_mut(stale.index) {
            message.content = stale.stub;
            message.image_attachments.clear();
        }
    }
    prune.watermark = messages.len();
}

/// Whether stubbing `saving` tokens of a `history`-token transcript is cheaper
/// than keeping them: the rewrite re-sends the whole history uncached once,
/// and saves `saving` cached tokens in each later round. Later rounds are
/// estimated as many as were sent so far. Near the context budget, or with
/// stale bytes (screenshots included) over a quarter of the request byte
/// budget, the rewrite always runs; otherwise small savings never justify one.
pub(super) fn worth_rewriting(
    saving: usize,
    (history, stale_bytes): (usize, usize),
    economy: &PruneEconomy,
) -> bool {
    let budget = economy.byte_limit as f64 / 4.0;
    let bytes = usize::try_from(economy.byte_limit).unwrap_or(usize::MAX);
    if history as f64 >= PRESSURE_RATIO * budget || stale_bytes > bytes / 4 {
        return true;
    }
    if saving < MIN_STALE_TOKENS {
        return false;
    }
    let ratio = economy
        .cached_ratio
        .filter(|value| value.is_finite())
        .unwrap_or(UNPRICED_CACHED_RATIO)
        .clamp(0.0, 1.0);
    let rounds = f64::from(economy.rounds_sent.max(1));
    rounds * saving as f64 * ratio > history as f64 * (1.0 - ratio)
}

fn strip_stills(messages: &mut [ModelRoundMessage]) {
    for message in messages {
        if message.role != ModelRoundRole::Tool
            || (!message.content.contains("still_file")
                && !message.content.contains("still_pending"))
        {
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
