//! Failure context omits the private control token in the instance record.

use std::time::Instant;

use butler_e2e::e2e::{scenario::Scenario, stop_intent::instance_record};

pub(super) fn snapshot(scenario: &Scenario, started: Instant) -> String {
    let record = instance_record(&scenario.sandbox.data);
    let record = match record {
        Some(record) => format!(
            "pid={} state={} app_enabled={}",
            record["pid"], record["state"], record["app_enabled"]
        ),
        None => "absent or unreadable".into(),
    };
    format!(
        "elapsed={:?} instance=({record})\nagent logs:\n{}",
        started.elapsed(),
        scenario.agent.logs()
    )
}
