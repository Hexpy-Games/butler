//! Per-session usage folded incrementally from the append-only prompt-usage
//! log: each read parses only the rows appended since the previous one.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde::Serialize;

use butler_models::models::{ModelPricing, UsageAuthMode};

use super::{UsageCostView, UsageEvent, UsageTotals};
use crate::operations::log_tail::LogTail;

const USAGE_FILE: &str = "metrics/prompt-cache-usage.jsonl";

/// `SessionView.usage`: one conversation's tokens and estimated cost.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SessionUsageView {
    /// Prompt tokens, cached and cache-written ones included.
    pub input_tokens: u64,
    /// Prompt tokens served from the provider cache.
    pub cached_input_tokens: u64,
    /// Prompt tokens written to the provider cache.
    pub cache_write_tokens: u64,
    /// Output tokens, reasoning included.
    pub output_tokens: u64,
    /// `None` when no request of the session reported reasoning tokens.
    pub reasoning_tokens: Option<u64>,
    /// Provider requests counted.
    pub request_count: u64,
    /// List-price estimate of the tokens above.
    pub cost: UsageCostView,
    /// Time of the latest counted request, `None` before the first.
    pub updated_at: Option<String>,
}

/// Session usage plus the billing mode of its latest request per model.
pub struct SessionUsage {
    /// `SessionView.usage`.
    pub view: SessionUsageView,
    /// Billing mode of the latest request per model ref.
    pub auth_modes: BTreeMap<String, UsageAuthMode>,
}

#[derive(Clone, Default)]
struct ScopeUsage {
    totals: UsageTotals,
    auth_modes: BTreeMap<String, UsageAuthMode>,
}

/// Usage per scope, kept current by reading the log's new rows.
#[derive(Default)]
pub struct SessionUsageIndex {
    tail: LogTail,
    scopes: HashMap<String, ScopeUsage>,
    prices: HashMap<String, Option<ModelPricing>>,
}

impl SessionUsageIndex {
    /// One runtime session's usage (its `btcc-guided:<id>` rows), after
    /// folding in the rows appended since the last read.
    pub fn read(
        &mut self,
        data_root: &Path,
        runtime_session_id: &str,
        pricing: &dyn Fn(&str) -> Option<ModelPricing>,
    ) -> SessionUsage {
        self.refresh(&data_root.join(USAGE_FILE), pricing);
        let scope = self
            .scopes
            .get(&format!("btcc-guided:{runtime_session_id}"))
            .cloned()
            .unwrap_or_default();
        SessionUsage {
            view: SessionUsageView {
                input_tokens: scope.totals.input_tokens,
                cached_input_tokens: scope.totals.cached_input_tokens,
                cache_write_tokens: scope.totals.cache_write_tokens,
                output_tokens: scope.totals.output_tokens,
                reasoning_tokens: scope.totals.reasoning_tokens,
                request_count: scope.totals.request_count,
                cost: scope.totals.cost(),
                updated_at: scope.totals.last_ts.and_then(iso),
            },
            auth_modes: scope.auth_modes,
        }
    }

    fn refresh(&mut self, path: &Path, pricing: &dyn Fn(&str) -> Option<ModelPricing>) {
        let mut tail = std::mem::take(&mut self.tail);
        // A replaced log is folded again from the start (prices are kept).
        tail.advance(
            path,
            self,
            |index| index.scopes.clear(),
            |index, line| index.fold(line, pricing),
        );
        self.tail = tail;
    }

    fn fold(&mut self, line: &[u8], pricing: &dyn Fn(&str) -> Option<ModelPricing>) {
        let Ok(event) = serde_json::from_slice::<UsageEvent>(line) else {
            return;
        };
        if !event.scope.starts_with("btcc-guided:") {
            return;
        }
        let price = self
            .prices
            .entry(event.model.clone())
            .or_insert_with(|| pricing(&event.model));
        let scope = self.scopes.entry(event.scope.clone()).or_default();
        scope.totals.add(&event, price.as_ref());
        if let Some(mode) = event.auth_mode {
            scope.auth_modes.insert(event.model.clone(), mode);
        }
    }
}

fn iso(epoch_ms: i64) -> Option<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(epoch_ms)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}
