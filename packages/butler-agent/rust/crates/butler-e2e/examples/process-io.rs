//! Native, platform-neutral counters for an open-app smoke's owned PIDs.
use butler_platform::process_control::usage;
use std::time::Duration;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let pids = std::env::args()
        .skip(1)
        .map(|arg| arg.parse::<u32>())
        .collect::<Result<Vec<_>, _>>()?;
    let before = pids
        .iter()
        .map(|pid| usage::sample(*pid))
        .collect::<Result<Vec<_>, _>>()?;
    println!("sampling {} owned processes for 60 s", pids.len());
    std::thread::sleep(Duration::from_secs(60));
    let mut total = 0;
    for (pid, before) in pids.iter().zip(before) {
        let before = before.ok_or("native process counters unavailable")?;
        let after = usage::sample(*pid)?.ok_or("process counters unavailable")?;
        let writes = after.write_bytes.saturating_sub(before.write_bytes);
        println!("pid={pid} write_bytes={writes}");
        total += writes;
    }
    println!("idle_write_bytes={total}");
    if total > 1_000_000 {
        return Err("idle write budget exceeded".into());
    }
    Ok(())
}
