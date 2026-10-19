//! Usage and indexed relation fixtures; no product test hooks.
use butler_e2e::e2e::HarnessError;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{fs, io::Write, path::Path};
pub(crate) fn row(
    scope: &str,
    root: Option<&str>,
    role: Option<&str>,
    input: u64,
    output: u64,
) -> Value {
    let mut row = json!({"ts":chrono::Utc::now().timestamp_millis()-1000,"model":"openai/gpt-6-luna","scope":format!("btcc-guided:{scope}"),"promptTokens":input,"cachedTokens":10,"totalTokens":input+output});
    if let Some(root) = root {
        row["rootSessionId"] = root.into();
    }
    if let Some(role) = role {
        row["role"] = role.into();
    }
    row
}
pub(crate) fn append(data: &Path, rows: &[Value]) -> Result<(), HarnessError> {
    fs::create_dir_all(data.join("metrics"))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data.join("metrics/prompt-cache-usage.jsonl"))?;
    for row in rows {
        writeln!(file, "{row}")?;
    }
    Ok(())
}
pub(crate) fn relations(
    data: &Path,
    links: &[(&str, &str, Option<&str>)],
) -> Result<(), HarnessError> {
    let mut db = Connection::open(data.join("agent-runtime/btcc.sqlite"))?;
    let tx = db.transaction()?;
    for (i, (child, parent, role)) in links.iter().enumerate() {
        tx.execute("INSERT INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at,activity_role,activity_worker_id,activity_terminal) VALUES (?1,?2,'usage-turn',?3,'usage-message',?4,'Usage task','2026-10-19T00:00:00Z',?5,?1,1)",params![format!("usage-{child}"),parent,child,i64::try_from(i).expect("fixture ordinal fits i64"),role])?;
    }
    tx.commit()?;
    Ok(())
}
pub(crate) fn model(value: &Value, requests: u64, input: u64, output: u64) {
    for (key, n) in [
        ("requestCount", requests),
        ("promptTokens", input),
        ("cachedTokens", requests * 10),
        ("outputTokens", output),
        ("totalTokens", input + output),
    ] {
        assert_eq!(
            value[key].as_f64(),
            Some(n as f64),
            "delegated {key}: {value}"
        );
    }
}
pub(crate) fn session(value: &Value, requests: u64, input: u64, output: u64) {
    for (key, n) in [
        ("request_count", requests),
        ("input_tokens", input),
        ("cached_input_tokens", requests * 10),
        ("cache_write_tokens", 0),
        ("output_tokens", output),
    ] {
        assert_eq!(
            value[key].as_u64(),
            Some(n),
            "session delegated {key}: {value}"
        );
    }
}

struct Clock;
impl butler_models::models::ProviderClock for Clock {
    fn now_epoch_millis(&self) -> i64 {
        chrono::Utc::now().timestamp_millis() - 1000
    }
}
pub(super) fn auxiliary(
    data: &Path,
    root: &str,
    role: &str,
    input: f64,
    output: f64,
) -> Result<(), HarnessError> {
    use butler_models::models::{
        PromptUsageAttribution, PromptUsageMetricInput, PromptUsageMetricSink,
    };
    let sink = butler_runtime::operations::PromptUsageMetrics::new(
        data.to_owned(),
        std::sync::Arc::new(Clock),
    );
    let mut attribution = PromptUsageAttribution::for_phase("planning");
    attribution.root_session_id = Some(root);
    attribution.role = Some(role);
    sink.append(PromptUsageMetricInput {
        model: "openai/gpt-6-luna",
        scope: "smart-search-planning",
        prompt_tokens: Some(input),
        cached_tokens: 10.0,
        total_tokens: Some(input + output),
        cache_write_tokens: None,
        prompt_cache_key: None,
        prompt_cache_retention: None,
        butler_data: None,
        usage_attribution: Some(&attribution),
        reasoning_tokens: None,
        cache_write_1h_tokens: None,
        auth_mode: None,
        prefix_diagnostics: None,
    })
    .unwrap();
    Ok(())
}
