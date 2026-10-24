//! Incremental activity folds; the response window is today minus 370 through today.
use super::{buckets::Tokens, row::UsageRow};
use butler_platform::time_zone::LocalZoneSource;
use chrono::{DateTime, Datelike, Days, NaiveDate, Utc};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
};

struct Span {
    first: f64,
    last: f64,
    session: Arc<str>,
}
#[derive(Default)]
pub(super) struct History {
    source: Option<LocalZoneSource>,
    zone: Option<tz::TimeZone>,
    daily: BTreeMap<NaiveDate, f64>,
    totals: Tokens,
    months: BTreeMap<(i32, u32), HashMap<String, f64>>,
    turns: HashMap<Arc<str>, Span>,
    longest: Option<Arc<str>>,
    dirty: bool,
    prefix: BTreeMap<NaiveDate, f64>,
    runs: BTreeMap<NaiveDate, NaiveDate>,
    busiest: Value,
    first_active: Option<NaiveDate>,
    streak: Value,
}
impl History {
    pub(super) fn sync_zone(
        &mut self,
        slots: impl Iterator<Item = (i64, Vec<(String, f64)>)>,
    ) -> std::io::Result<()> {
        let source = LocalZoneSource::current()?;
        if self.source.as_ref() == Some(&source) {
            return Ok(());
        }
        let zone = tz::TimeZone::from_tz_data(&source.rules()?).map_err(std::io::Error::other)?;
        self.zone = Some(zone);
        self.source = Some(source);
        self.daily.clear();
        self.months.clear();
        for (slot, providers) in slots {
            for (provider, tokens) in providers {
                self.add_tokens(slot, &provider, tokens);
            }
        }
        self.dirty = true;
        Ok(())
    }
    fn date(&self, ts: i64) -> Option<NaiveDate> {
        let offset = self
            .zone
            .as_ref()?
            .find_local_time_type(ts.div_euclid(1000))
            .ok()?
            .ut_offset();
        DateTime::<Utc>::from_timestamp_millis(ts.checked_add(i64::from(offset) * 1000)?)
            .map(|dt| dt.date_naive())
    }
    fn add_tokens(&mut self, slot: i64, provider: &str, tokens: f64) {
        if let Some(date) = self.date(slot) {
            *self.daily.entry(date).or_default() += tokens;
            *self
                .months
                .entry((date.year(), date.month()))
                .or_default()
                .entry(provider.to_owned())
                .or_default() += tokens;
        }
    }
    pub(super) fn month_tokens(&self, now: i64, provider: &str) -> Option<f64> {
        let date = self.date(now)?;
        Some(
            self.months
                .get(&(date.year(), date.month()))
                .and_then(|providers| providers.get(provider))
                .copied()
                .unwrap_or(0.0),
        )
    }
    pub(super) fn push(&mut self, slot: i64, row: &UsageRow) {
        let mut tokens = Tokens::default();
        tokens.add(row);
        self.totals.merge(&tokens);
        self.add_tokens(slot, super::provider_id(&row.model), tokens.total);
        self.dirty = true;
        let Some(turn) = &row.turn_id else {
            return;
        };
        let span = self.turns.entry(turn.clone()).or_insert_with(|| Span {
            first: row.ts,
            last: row.ts,
            session: row.root_session_id.clone().unwrap_or_else(|| {
                Arc::from(row.scope.strip_prefix("btcc-guided:").unwrap_or(&row.scope))
            }),
        });
        span.first = span.first.min(row.ts);
        span.last = span.last.max(row.ts);
        if let Some(root) = &row.root_session_id {
            span.session = root.clone();
        }
        let duration = span.last - span.first;
        if self
            .longest
            .as_ref()
            .and_then(|id| self.turns.get(id))
            .is_none_or(|old| duration > old.last - old.first)
        {
            self.longest = Some(turn.clone());
        }
    }
    fn summarize(&mut self) {
        if !self.dirty {
            return;
        }
        self.prefix.clear();
        self.runs.clear();
        let (mut total, mut max) = (0.0, 0.0);
        let (mut start, mut previous) = (None, None);
        let mut longest = 0;
        self.busiest = Value::Null;
        self.first_active = None;
        self.streak = json!({"days":0,"start":null,"end":null});
        for (&date, &tokens) in &self.daily {
            total += tokens;
            self.prefix.insert(date, total);
            if tokens <= 0.0 {
                continue;
            }
            self.first_active.get_or_insert(date);
            if tokens >= max {
                max = tokens;
                self.busiest = json!({"date":date.to_string(),"tokens":tokens});
            }
            if previous.and_then(|d: NaiveDate| d.succ_opt()) != Some(date) {
                start = Some(date);
            }
            let first = start.unwrap_or(date);
            if previous.and_then(|d: NaiveDate| d.succ_opt()) == Some(date)
                && let Some(last) = previous
            {
                self.runs.remove(&last);
            }
            self.runs.insert(date, first);
            let days = (date - first).num_days() + 1;
            if days > longest {
                longest = days;
                self.streak = json!({"days":days,"start":first.to_string(),"end":date.to_string()});
            }
            previous = Some(date);
        }
        self.dirty = false;
    }
    pub(super) fn view(&mut self, now: i64) -> std::io::Result<Value> {
        self.summarize();
        let today = self.date(now).ok_or(std::io::ErrorKind::InvalidData)?;
        let first = today
            .checked_sub_days(Days::new(370))
            .ok_or(std::io::ErrorKind::InvalidData)?;
        let days: Vec<_> = (0..371)
            .filter_map(|n| first.checked_add_days(Days::new(n)))
            .map(|date| {
                json!([
                    date.to_string(),
                    self.daily.get(&date).copied().unwrap_or(0.0)
                ])
            })
            .collect();
        let prior = self
            .prefix
            .range(..first)
            .next_back()
            .map_or(0.0, |(_, total)| *total);
        let current = self.runs.get_key_value(&today).or_else(|| {
            today
                .pred_opt()
                .and_then(|yesterday| self.runs.get_key_value(&yesterday))
        });
        let current = current.map_or_else(
            || json!({"days":0,"start":null}),
            |(end, start)| json!({"days":(*end-*start).num_days()+1,"start":start.to_string()}),
        );
        let task = self.longest.as_ref().and_then(|id| self.turns.get(id)).map(
            |span| json!({"durationMs":span.last-span.first,"sessionId":span.session,"title":null}),
        );
        Ok(
            json!({"lifetimeTokens":self.totals.total,"busiestDay":self.busiest,"longestTask":task,
            "longestStreak":self.streak,"currentStreak":current,"days":days,"priorTotal":prior,
            "firstActiveDate":self.first_active.map(|date| date.to_string()),
            "timeZone":self.source.as_ref().map(|source| &source.name)}),
        )
    }
}
