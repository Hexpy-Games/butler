//! Source ICU 78 English specific names and metazone periods. Immutable data
//! is parsed once by the clock owner; formatting retains no conversation data.

use std::collections::HashMap;

use serde::Deserialize;

use crate::context::ContextResult;

use super::failure;

#[derive(Deserialize)]
struct SpecificNames {
    ss: Option<String>,
    sd: Option<String>,
}

impl SpecificNames {
    fn for_variant(&self, daylight: bool) -> Option<&str> {
        if daylight {
            self.sd.as_deref()
        } else {
            self.ss.as_deref()
        }
    }
}

#[derive(Deserialize)]
struct RawData {
    names: HashMap<String, SpecificNames>,
    periods: HashMap<String, Vec<Vec<String>>>,
}

struct Period {
    start: i64,
    end: i64,
    name_key: String,
}

pub(super) struct TimeZoneNames {
    names: HashMap<String, SpecificNames>,
    periods: HashMap<String, Vec<Period>>,
}

impl TimeZoneNames {
    pub(super) fn new() -> ContextResult<Self> {
        let raw: RawData = serde_json::from_str(include_str!(
            "../../../resources/timezones/names-icu78.json"
        ))
        .map_err(|error| failure(error.to_string()))?;
        let default_end = timestamp("9999-12-31 23:59")?;
        let mut periods = HashMap::with_capacity(raw.periods.len());
        for (key, values) in raw.periods {
            let mut result = Vec::with_capacity(values.len());
            for value in values {
                let (name, start, end) = match value.as_slice() {
                    [name] => (name, 0, default_end),
                    [name, start, end] => (name, timestamp(start)?, timestamp(end)?),
                    _ => return Err(failure("Invalid embedded metazone period")),
                };
                result.push(Period {
                    start,
                    end,
                    name_key: format!("meta:{name}"),
                });
            }
            periods.insert(key, result);
        }
        Ok(Self {
            names: raw.names,
            periods,
        })
    }

    pub(super) fn specific(&self, canonical: &str, epoch: i64, daylight: bool) -> Option<&str> {
        let key = canonical.replace('/', ":");
        if let Some(value) = self
            .names
            .get(&key)
            .and_then(|names| names.for_variant(daylight))
        {
            return Some(value);
        }
        let period = self
            .periods
            .get(&key)?
            .iter()
            .find(|period| epoch >= period.start && epoch < period.end)?;
        self.names
            .get(&period.name_key)
            .and_then(|names| names.for_variant(daylight))
    }
}

fn timestamp(value: &str) -> ContextResult<i64> {
    let iso = format!("{}:00.000Z", value.replace(' ', "T"));
    crate::js_date::parse_iso_millis(&iso)
        .ok_or_else(|| failure("Invalid embedded metazone timestamp"))
}
