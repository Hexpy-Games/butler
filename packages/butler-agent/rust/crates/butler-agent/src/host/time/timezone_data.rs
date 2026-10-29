//! Frozen baseline TZif data, embedded in the executable. Only the immutable
//! name/byte-slice index is retained; one parsed zone belongs to one time read.

use std::cmp::Ordering;

use butler_platform::time_zone::BaselineZone;
use butler_runtime::context::{ContextCode, ContextError, ContextResult};

fn failure(message: impl Into<String>) -> ContextError {
    ContextError::new(ContextCode::PromptTimeFormatError, message)
}

pub(in crate::host) struct TimeZoneData {
    entries: Vec<BaselineZone>,
}

impl TimeZoneData {
    pub(in crate::host) fn new() -> ContextResult<Self> {
        let entries = butler_platform::time_zone::baseline_zones().map_err(|error| {
            failure(format!("Invalid embedded time zone data: {error}")).with_source(error)
        })?;
        Ok(Self { entries })
    }

    pub(in crate::host) fn find(&self, name: &str) -> ContextResult<tz::TimeZone> {
        let index = self
            .entries
            .binary_search_by(|entry| compare(entry.name, name))
            .map_err(|_| failure("Unknown time zone"))?;
        tz::TimeZone::from_tz_data(self.entries[index].rules)
            .map_err(|error| failure(error.to_string()).with_source(error))
    }

    pub(in crate::host) fn facts(
        &self,
        name: &str,
        epoch: i64,
    ) -> ContextResult<(i32, bool, &'static str)> {
        // ICU also exposes legacy short IDs that ECMAScript Intl rejects.
        const ICU_ONLY: &[&str] = &[
            "ACT",
            "AET",
            "AGT",
            "ART",
            "AST",
            "BET",
            "BST",
            "CAT",
            "CNT",
            "CST",
            "CTT",
            "EAT",
            "ECT",
            "IET",
            "IST",
            "JST",
            "MIT",
            "NET",
            "NST",
            "PLT",
            "PNT",
            "PRT",
            "PST",
            "SST",
            "VST",
            "Etc/Unknown",
        ];
        if ICU_ONLY
            .iter()
            .any(|alias| name.eq_ignore_ascii_case(alias))
        {
            return Err(failure("Unknown time zone"));
        }
        let index = self
            .entries
            .binary_search_by(|entry| compare(entry.name, name))
            .map_err(|_| failure("Unknown time zone"))?;
        let zone = self.find(name)?;
        let view = zone.as_ref();
        let local = zone
            .find_local_time_type(epoch)
            .map_err(|error| failure(error.to_string()).with_source(error))?;
        let daylight = match view.extra_rule() {
            Some(tz::timezone::TransitionRule::Alternate(rule))
                if view
                    .transitions()
                    .last()
                    .is_some_and(|last| epoch >= last.unix_leap_time())
                    && rule.dst().ut_offset() < rule.std().ut_offset()
                    && (local == rule.std() || local == rule.dst()) =>
            {
                !local.is_dst()
            }
            _ => local.is_dst(),
        };
        Ok((local.ut_offset(), daylight, self.entries[index].canonical))
    }
}

fn compare(left: &str, right: &str) -> Ordering {
    left.bytes()
        .map(|byte| byte.to_ascii_lowercase())
        .cmp(right.bytes().map(|byte| byte.to_ascii_lowercase()))
}
