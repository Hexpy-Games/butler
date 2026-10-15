//! One million tool events must not retain a map and copied name per timestamp.
use super::*;

#[tokio::test]
async fn perf_usage_million_tool_events_are_compact() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("usage-tool-memory")?;
    seed(&setup.sandbox.data)?;
    let s = setup.start().await?;
    let memory = super::memory::PeakMemory::start(s.agent.pid().unwrap());
    let mut range = None;
    for suffix in ["?since_hours=24", ""] {
        let (_, view) = timed(&s.gw, &format!("/usage-monitor{suffix}")).await?;
        assert_eq!(view["tools"]["calls"], 500_000);
        assert_eq!(view["tools"]["failures"], 500_000);
        let tools = view["tools"]["byTool"].as_object().unwrap();
        assert_eq!(tools.len(), 512);
        assert_eq!(
            tools
                .values()
                .map(|v| v["calls"].as_u64().unwrap())
                .sum::<u64>(),
            500_000
        );
        assert_eq!(
            tools
                .values()
                .map(|v| v["failures"].as_u64().unwrap())
                .sum::<u64>(),
            500_000
        );
        assert!(tools.contains_key("__other__"));
        assert!(tools.contains_key("tool-510"));
        assert!(!tools.contains_key("tool-511"));
        if let Some(range) = &range {
            assert_eq!(tools, range);
        } else {
            range = Some(tools.clone());
        }
    }
    // 8-byte boundary records plus bounded scan buffers and slot counters.
    // Main's review baseline was ~20 MB; the regressed index used ~920 MB.
    memory.finish(40 * 1024 * 1024);
    s.finish().await
}

fn seed(data: &Path) -> Result<(), HarnessError> {
    let directory = data.join("transcripts");
    fs::create_dir_all(&directory)?;
    let mut file = std::io::BufWriter::new(fs::File::create(directory.join("tools.jsonl"))?);
    let now = chrono_now();
    let base = now - 2_000_000;
    for index in 0..1_000_000 {
        let ts = chrono::DateTime::from_timestamp_millis(base + index)
            .unwrap()
            .to_rfc3339();
        let kind = if index % 2 == 0 {
            "tool_call"
        } else {
            "tool_result"
        };
        writeln!(
            file,
            "{}",
            serde_json::json!({"timestamp":ts,"kind":kind,
            "payload":{"name":format!("tool-{}", index%600),"ok":false}})
        )?;
    }
    file.flush()?;
    drop(file);
    Ok(())
}

/// Explicit `bench_usage_` selection, outside the budget-enforcing `perf_` suite.
/// All-time counters supported by both binaries for per-million growth evidence.
#[tokio::test]
async fn bench_usage_comparable_million_tools() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("usage-comparable-tools")?;
    seed(&setup.sandbox.data)?;
    let s = setup.start().await?;
    let memory = super::memory::PeakMemory::start(s.agent.pid().unwrap());
    let (_, view) = timed(&s.gw, "/usage-monitor").await?;
    assert_eq!(view["tools"]["calls"], 500_000);
    assert_eq!(view["tools"]["failures"], 500_000);
    let tools = view["tools"]["byTool"].as_object().unwrap();
    for field in ["calls", "failures"] {
        assert_eq!(
            tools
                .values()
                .map(|v| v[field].as_u64().unwrap())
                .sum::<u64>(),
            500_000
        );
    }
    memory.measure();
    s.finish().await
}
