//! Native I/O samples for isolated App acceptance; accepts explicit PIDs and identities.
use butler_platform::{instance::process_start, process_control::sample_usage};
use serde_json::{Value, json};
use std::error::Error;

fn main() -> Result<(), Box<dyn Error>> {
    let mut samples = Vec::new();
    for argument in std::env::args().skip(1) {
        let (pid, expected) = argument
            .split_once('@')
            .map_or((argument.as_str(), None), |(pid, expected)| {
                (pid, Some(expected))
            });
        samples.push(sample(pid.parse()?, expected));
    }
    if samples.is_empty() {
        return Err("provide at least one owned process PID".into());
    }
    println!("{}", serde_json::to_string(&samples)?);
    Ok(())
}

fn unavailable(pid: u32, error: &str) -> Value {
    json!({"pid":pid,"status":"unavailable","write_bytes":null,"error":error})
}

fn sample(pid: u32, expected: Option<&str>) -> Value {
    let started = match process_start(pid) {
        Ok(Some(started)) => started,
        Ok(None) => return unavailable(pid, "process_exited"),
        Err(error) => return unavailable(pid, &error.to_string()),
    };
    if expected.is_some_and(|expected| expected != started) {
        return unavailable(pid, "process_identity_changed");
    }
    match sample_usage(pid) {
        Ok(Some(usage)) => {
            if process_start(pid).ok().flatten().as_deref() != Some(started.as_str()) {
                return unavailable(pid, "process_identity_changed");
            }
            json!({"pid":pid,"process_start":started,"status":"available",
                "write_bytes":usage.write_bytes,"read_bytes":usage.read_bytes,
                "resident_bytes":usage.resident_bytes})
        }
        Ok(None) => unavailable(pid, "resource counters unavailable"),
        Err(error) => unavailable(pid, &error.to_string()),
    }
}
