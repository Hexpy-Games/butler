//! 640 scopes and 300k requests over thirty days, including low-ranked selection.
use super::super::usage_timeline::assert_timeline;
use super::*;
use std::collections::BTreeMap;
const ROW_COUNT: usize = 300_000;
const SCOPE_COUNT: usize = 640;
const SLOT_MS: i64 = 900_000;

fn scope_index(index: usize) -> usize {
    ((index / 100) * 13 + index % 20) % SCOPE_COUNT
}
fn scope(index: usize) -> String {
    if scope_index(index) == SCOPE_COUNT - 1 {
        "btcc-guided:butler/app-general".into()
    } else {
        format!("job:{:03}", scope_index(index))
    }
}
fn timestamp(base: i64, index: usize) -> i64 {
    base - i64::try_from((index / 100) % 2880).expect("slot fits i64") * SLOT_MS
}
fn total(index: usize) -> f64 {
    if scope_index(index) == SCOPE_COUNT - 1 {
        120.0
    } else {
        1200.0
    }
}
fn sections(tokens: u64) -> Value {
    serde_json::json!(
        (0..20)
            .map(|index| serde_json::json!({
                "id":format!("section-{index:02}"),"chars":tokens*4,"estimatedTokens":tokens
            }))
            .collect::<Vec<_>>()
    )
}
fn seed(data: &Path, base: i64) -> Result<(), HarnessError> {
    fs::create_dir_all(data.join("metrics"))?;
    let mut log = std::io::BufWriter::new(fs::File::create(
        data.join("metrics/prompt-cache-usage.jsonl"),
    )?);
    let normal_sections = sections(50);
    let small_sections = sections(5);
    for index in 0..ROW_COUNT {
        let mut row: Value = serde_json::from_str(&usage_row(
            u64::try_from(index).expect("row index fits u64"),
            &scope(index),
            timestamp(base, index),
        ))?;
        row["totalTokens"] = serde_json::json!(total(index));
        row["promptSections"] = if scope_index(index) == SCOPE_COUNT - 1 {
            small_sections.clone()
        } else {
            normal_sections.clone()
        };
        if scope_index(index) == SCOPE_COUNT - 1 {
            row["promptTokens"] = serde_json::json!(100);
            row["cachedTokens"] = serde_json::json!(40);
        }
        writeln!(log, "{row}")?;
    }
    log.flush()?;
    let bytes = log.get_ref().metadata()?.len();
    assert!(bytes > 300 * 1024 * 1024, "owner metrics size: {bytes}");
    eprintln!("usage timeline fixture: {ROW_COUNT} rows, {SCOPE_COUNT} scopes, {bytes} bytes");
    Ok(())
}
fn verify(view: &Value, base: i64, selected: bool) {
    assert_timeline(view);
    let since = view["filters"]["sinceTs"].as_f64().unwrap();
    let mut slots = BTreeMap::<i64, u64>::new();
    let mut scopes = BTreeMap::<String, (f64, u64, i64)>::new();
    let mut requests = 0;
    let mut tokens = 0.0;
    let mut prompt = 0.0;
    let mut previous = 0.0;
    let now = view["filters"]["untilTs"].as_f64().unwrap();
    for index in 0..ROW_COUNT {
        let ts = timestamp(base, index);
        let id = scope(index);
        let in_scope = !selected || id == "btcc-guided:butler/app-general";
        if ts as f64 >= since {
            let entry = scopes.entry(id).or_default();
            entry.0 += total(index);
            entry.1 += 1;
            entry.2 = entry.2.max(ts);
            if in_scope {
                *slots.entry(ts.div_euclid(SLOT_MS) * SLOT_MS).or_default() += 1;
                requests += 1;
                tokens += total(index);
                prompt += if scope_index(index) == SCOPE_COUNT - 1 {
                    100.0
                } else {
                    1000.0
                };
            }
        } else if ts as f64 >= since - (now - since) && in_scope {
            previous += total(index);
        }
    }
    assert_eq!(view["model"]["requestCount"], requests);
    assert_eq!(view["model"]["totalTokens"], tokens);
    assert_eq!(view["model"]["promptTokens"], prompt);
    assert_eq!(view["model"]["cachedTokens"], prompt * 0.4);
    assert_eq!(view["model"]["outputTokens"], prompt / 5.0);
    let sections = view["model"]["bySection"].as_object().unwrap();
    assert_eq!(sections.len(), if requests > 0 { 20 } else { 0 });
    for section in sections.values() {
        assert_eq!(section["requestCount"], requests);
        assert_eq!(section["chars"], prompt / 5.0);
        assert_eq!(section["estimatedTokens"], prompt / 20.0);
    }
    assert_eq!(
        view["model"]["byModel"]["openai/gpt-6-luna"]["totalTokens"],
        tokens
    );
    assert_eq!(view["previousPeriod"]["totalTokens"], previous);
    let actual = view["timeline"]["slots"].as_array().unwrap();
    assert_eq!(actual.len(), slots.len());
    for (row, (ts, count)) in actual.iter().zip(slots) {
        assert_eq!(row[0], ts);
        assert_eq!(row[1], count);
    }
    let top = view["topSessions"].as_array().unwrap();
    assert!(
        top.windows(2)
            .all(|s| s[0]["totalTokens"].as_f64() >= s[1]["totalTokens"].as_f64())
    );
    let mut expected: Vec<_> = scopes.into_iter().collect();
    expected.sort_by(|a, b| b.1.0.total_cmp(&a.1.0).then_with(|| a.0.cmp(&b.0)));
    assert_eq!(top.len(), if selected { 201 } else { 200 });
    for (row, (id, (total, requests, last))) in top.iter().take(200).zip(expected) {
        assert_eq!(row["sessionId"], id);
        assert_eq!(row["totalTokens"], total);
        assert_eq!(row["requests"], requests);
        assert_eq!(row["lastUsedMs"], last as f64);
    }
    if selected {
        assert_eq!(top.last().unwrap()["sessionId"], "general");
    }
}
#[tokio::test]
async fn perf_usage_timeline_300k_ranges() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("usage-timeline-scale")?;
    let base = chrono_now().div_euclid(SLOT_MS) * SLOT_MS - SLOT_MS / 2;
    seed(&setup.sandbox.data, base)?;
    let s = setup.start().await?;
    let memory = super::memory::PeakMemory::start(s.agent.pid().unwrap());
    let (ingest, view) = timed(&s.gw, "/usage-monitor?since_hours=720").await?;
    verify(&view, base, false);
    butler_e2e::assert_wall_clock_budget!(ingest, COLD, "300k ingest");
    eprintln!("usage timeline 300k ingest + initial request: {ingest:?}");
    for hours in [24, 168, 720] {
        for selected in [false, true] {
            let suffix = if selected { "&session_id=general" } else { "" };
            let (latency, view) = timed(
                &s.gw,
                &format!("/usage-monitor?since_hours={hours}{suffix}"),
            )
            .await?;
            verify(&view, base, selected);
            eprintln!("usage timeline {hours}h scoped={selected}: {latency:?}");
            butler_e2e::assert_wall_clock_budget!(latency, WARM, "timeline range");
        }
    }
    // Main's measured physical footprint baseline plus at most ten percent.
    memory.finish_peak(390_500_000);
    s.finish().await
}

/// Identical fixture and legacy-field correctness for baseline binary comparisons.
/// BUTLER_E2E_BIN can select main without depending on the new JSON fields.
#[tokio::test]
async fn perf_usage_comparable_300k() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("usage-comparable")?;
    let base = chrono_now().div_euclid(SLOT_MS) * SLOT_MS - SLOT_MS / 2;
    seed(&setup.sandbox.data, base)?;
    let s = setup.start().await?;
    let memory = super::memory::PeakMemory::start(s.agent.pid().unwrap());
    let (cold, view) = timed(&s.gw, "/usage-monitor?since_hours=720").await?;
    verify_legacy(&view, base, false);
    eprintln!("comparable cold: {cold:?}");
    for hours in [24, 168, 720] {
        for scoped in [false, true] {
            let suffix = if scoped { "&session_id=general" } else { "" };
            let (elapsed, view) = timed(
                &s.gw,
                &format!("/usage-monitor?since_hours={hours}{suffix}"),
            )
            .await?;
            verify_legacy(&view, base, scoped);
            eprintln!("comparable {hours}h scoped={scoped}: {elapsed:?}");
        }
    }
    let (_, before) = timed(&s.gw, "/usage-monitor").await?;
    for index in 0..3 {
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(s.sandbox.data.join("metrics/prompt-cache-usage.jsonl"))?;
        writeln!(
            file,
            "{}",
            usage_row(ROW_COUNT as u64 + index, "worker", chrono_now())
        )?;
        drop(file);
        let (elapsed, view) = timed(&s.gw, "/usage-monitor").await?;
        assert_eq!(view["model"]["requestCount"], ROW_COUNT as u64 + index + 1);
        assert_eq!(
            view["model"]["totalTokens"].as_f64().unwrap(),
            before["model"]["totalTokens"].as_f64().unwrap() + 1200.0 * (index + 1) as f64
        );
        assert_eq!(view["model"]["bySection"], before["model"]["bySection"]);
        eprintln!("comparable all-time append {index}: {elapsed:?}");
    }
    memory.measure();
    s.finish().await
}

fn verify_legacy(view: &Value, base: i64, scoped: bool) {
    let since = view["filters"]["sinceTs"].as_f64().unwrap();
    let mut count = 0;
    let mut tokens = 0.0;
    let mut prompt = 0.0;
    for index in 0..ROW_COUNT {
        if timestamp(base, index) as f64 >= since
            && (!scoped || scope_index(index) == SCOPE_COUNT - 1)
        {
            count += 1;
            tokens += total(index);
            prompt += total(index) / 1.2;
        }
    }
    assert_eq!(view["model"]["requestCount"], count);
    assert_eq!(view["model"]["totalTokens"], tokens);
    assert_eq!(view["model"]["promptTokens"], prompt);
    assert_eq!(view["model"]["cachedTokens"], prompt * 0.4);
    assert_eq!(
        view["model"]["byModel"]["openai/gpt-6-luna"]["totalTokens"],
        tokens
    );
    let sections = view["model"]["bySection"].as_object().unwrap();
    assert_eq!(sections.len(), if count == 0 { 0 } else { 20 });
    for section in sections.values() {
        assert_eq!(section["requestCount"], count);
        assert_eq!(section["estimatedTokens"], prompt / 20.0);
        assert_eq!(section["chars"], prompt / 5.0);
    }
}
