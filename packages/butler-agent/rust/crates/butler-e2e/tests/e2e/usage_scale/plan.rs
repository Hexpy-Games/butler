//! SIWC-17: multiply attributed rows at fixed slots, preserving exact sums.
use super::super::chatgpt_plan_usage::windows::{account_key, assert_windows, row};
use super::*;
#[tokio::test]
async fn perf_siwc_17_attributed_windows_at_owner_scale() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("SIWC-17-SCALE")?;
    let now = chrono_now();
    let mut expected = write_usage_log(&setup.sandbox.data, now)?;
    write_transcripts(&setup.sandbox.data, &mut expected)?;
    let s = setup.start().await?;
    let key = account_key(&s.sandbox.data)?;
    let path = s.sandbox.data.join("metrics/prompt-cache-usage.jsonl");
    for multiplier in [1, 4] {
        let mut file = fs::OpenOptions::new().append(true).open(&path)?;
        for hour in 1..=744 {
            let copies = if multiplier == 1 {
                1
            } else if hour < 720 {
                3
            } else {
                0
            };
            for _ in 0..copies {
                writeln!(
                    file,
                    "{}",
                    row(
                        now - hour * 3_600_000 - 1_800_000,
                        Some(&key),
                        "subscription"
                    )
                )?;
            }
        }
        file.flush()?;
        drop(file);
        let (_, cold) = timed(&s.gw, "/usage-monitor?since_hours=24").await?;
        assert_windows(&cold, [4 * multiplier, 167 * multiplier, 719 * multiplier]);
        let (elapsed, warm) = timed(&s.gw, "/usage-monitor?since_hours=24").await?;
        assert_windows(&warm, [4 * multiplier, 167 * multiplier, 719 * multiplier]);
        let count = expected.recent_rows + 23 * multiplier;
        assert_eq!(warm["model"]["requestCount"], count);
        assert_eq!(
            warm["model"]["totalTokens"].as_f64(),
            Some((count * 1200) as f64)
        );
        super::super::usage_timeline::assert_timeline(&warm);
        eprintln!(
            "SIWC-17 {multiplier}x warm={elapsed:?}; requests={:?}; input=1000, output=200, total=1200 per request",
            [4 * multiplier, 167 * multiplier, 719 * multiplier]
        );
        butler_e2e::assert_wall_clock_budget!(elapsed, WARM, "SIWC-17 warm window sums");
    }
    s.finish().await
}
