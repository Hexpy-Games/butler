//! Per-session usage folded incrementally from the append-only prompt-usage
//! log: each read parses only the rows appended since the previous one.

use crate::operations::UsageOwners;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::Arc;

use serde::Serialize;

use butler_models::models::{ModelPricing, UsageAuthMode};

use super::{UsageCostView, UsageEvent, UsageTotals};
use crate::operations::log_tail::LogTail;

const USAGE_FILE: &str = "metrics/prompt-cache-usage.jsonl";

/// `SessionView.usage`: one conversation's tokens and estimated cost.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SessionUsageView {
    /// All requests split by the writing session policy role.
    pub by_role: BTreeMap<String, SessionRoleUsage>,
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
    auth_modes: BTreeMap<String, (i64, UsageAuthMode)>,
}

/// Usage per scope, kept current by reading the log's new rows.
#[derive(Default)]
pub struct SessionUsageIndex {
    owners: Arc<UsageOwners>,
    tail: LogTail,
    scopes: HashMap<String, ScopeUsage>,
    prices: HashMap<String, Option<ModelPricing>>,
}

impl SessionUsageIndex {
    /// Share lineage with the usage monitor.
    pub fn with_owners(owners: Arc<UsageOwners>) -> Self {
        Self {
            owners,
            ..Self::default()
        }
    }
    /// One runtime session's usage (its `btcc-guided:<id>` rows), after
    /// folding in the rows appended since the last read.
    pub fn read(
        &mut self,
        data_root: &Path,
        runtime_session_id: &str,
        pricing: &dyn Fn(&str) -> Option<ModelPricing>,
    ) -> SessionUsage {
        self.refresh(&data_root.join(USAGE_FILE), pricing);
        self.session_usage(runtime_session_id)
    }

    /// Refresh usage and another prompt-log projection in one fresh file pass.
    /// Usage still counts only newline-terminated rows and accepts complete
    /// oversized events; the other projection retains its own trailing policy.
    pub fn read_with_rows<S>(
        &mut self,
        data_root: &Path,
        runtime_session_id: &str,
        pricing: &dyn Fn(&str) -> Option<ModelPricing>,
        state: &mut S,
        callbacks: (impl FnOnce(&mut S), impl FnMut(&mut S, &[u8])),
    ) -> SessionUsage {
        let (reset, mut visit) = callbacks;
        let mut tail = std::mem::take(&mut self.tail);
        tail.advance_with_trailing(
            &data_root.join(USAGE_FILE),
            &mut (&mut *self, state),
            |(index, state)| {
                index.scopes.clear();
                reset(state);
            },
            |(index, state), row| {
                if row.ends_with(b"\n") {
                    index.fold(row, pricing);
                }
                visit(state, row);
            },
        );
        self.tail = tail;
        self.session_usage(runtime_session_id)
    }

    /// Project the selected root after a refresh and asynchronous lineage resolution.
    pub fn session_usage(&self, runtime_session_id: &str) -> SessionUsage {
        let root = self
            .owners
            .root_scope(&format!("btcc-guided:{runtime_session_id}"));
        let mut scope = ScopeUsage::default();
        let mut roles = BTreeMap::<String, UsageTotals>::new();
        for (member, role) in self.owners.members(&root) {
            if let Some(value) = self.scopes.get(member.as_ref()) {
                scope.totals.merge(&value.totals);
                roles
                    .entry(role.to_string())
                    .or_default()
                    .merge(&value.totals);
                for (model, &(ts, mode)) in &value.auth_modes {
                    if scope
                        .auth_modes
                        .get(model)
                        .is_none_or(|(current, _)| ts >= *current)
                    {
                        scope.auth_modes.insert(model.clone(), (ts, mode));
                    }
                }
            }
        }
        SessionUsage {
            view: SessionUsageView {
                by_role: roles
                    .into_iter()
                    .map(|(role, totals)| (role, SessionRoleUsage::from(totals)))
                    .collect(),
                input_tokens: scope.totals.input_tokens,
                cached_input_tokens: scope.totals.cached_input_tokens,
                cache_write_tokens: scope.totals.cache_write_tokens,
                output_tokens: scope.totals.output_tokens,
                reasoning_tokens: scope.totals.reasoning_tokens,
                request_count: scope.totals.request_count,
                cost: scope.totals.cost(),
                updated_at: scope.totals.last_ts.and_then(iso),
            },
            auth_modes: scope
                .auth_modes
                .into_iter()
                .map(|(model, (_, mode))| (model, mode))
                .collect(),
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
        self.owners.observe(
            &event.scope,
            event.root_session_id.as_deref(),
            event.role.as_deref(),
        );
        if event.root_session_id.is_none() && !event.scope.starts_with("btcc-guided:") {
            return;
        }
        let price = self
            .prices
            .entry(event.model.clone())
            .or_insert_with(|| pricing(&event.model));
        let scope = self.scopes.entry(event.scope.clone()).or_default();
        scope.totals.add(&event, price.as_ref());
        if let Some(mode) = event.auth_mode {
            scope
                .auth_modes
                .insert(event.model.clone(), (event.ts, mode));
        }
    }
}

fn iso(epoch_ms: i64) -> Option<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(epoch_ms)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// Token counts for one policy role within a root chat.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SessionRoleUsage {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_write_tokens: u64,
    pub output_tokens: u64,
    pub request_count: u64,
}
impl From<UsageTotals> for SessionRoleUsage {
    fn from(t: UsageTotals) -> Self {
        Self {
            input_tokens: t.input_tokens,
            cached_input_tokens: t.cached_input_tokens,
            cache_write_tokens: t.cache_write_tokens,
            output_tokens: t.output_tokens,
            request_count: t.request_count,
        }
    }
}
