//! Native I/O samples for isolated App acceptance; accepts only explicit PIDs.
use std::error::Error;

fn main() -> Result<(), Box<dyn Error>> {
    let mut samples = Vec::new();
    for argument in std::env::args().skip(1) {
        let pid: u32 = argument.parse()?;
        let usage = butler_platform::process_control::sample_usage(pid)?
            .ok_or("process resource counters unavailable")?;
        samples.push(serde_json::json!({
            "pid": pid,
            "write_bytes": usage.write_bytes,
            "read_bytes": usage.read_bytes,
            "resident_bytes": usage.resident_bytes,
        }));
    }
    if samples.is_empty() {
        return Err("provide at least one owned process PID".into());
    }
    println!("{}", serde_json::to_string(&samples)?);
    Ok(())
}
