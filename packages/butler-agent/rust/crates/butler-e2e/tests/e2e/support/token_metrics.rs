//! Content-free measurements of captured stub traffic and persisted diagnostics.
#![allow(clippy::unwrap_used, reason = "test assertions")]
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(crate) fn report(
    s: &Scenario,
    requests: &[Value],
    label: &str,
) -> Result<Vec<Value>, HarnessError> {
    let tokenizer = tiktoken_rs::o200k_base().map_err(|e| HarnessError(e.to_string()))?;
    let rows: Vec<Value> =
        std::fs::read_to_string(s.sandbox.data.join("metrics/prompt-cache-usage.jsonl"))?
            .lines()
            .map(serde_json::from_str)
            .collect::<Result<_, _>>()?;
    let rows: Vec<_> = rows
        .into_iter()
        .filter(|row| {
            row["scope"]
                .as_str()
                .is_some_and(|scope| scope.starts_with("btcc-guided:"))
        })
        .collect();
    assert_eq!(rows.len(), requests.len());
    let starts: Vec<Value> = std::fs::read_to_string(
        s.sandbox
            .data
            .join("metrics/request-prefix-diagnostics.jsonl"),
    )?
    .lines()
    .map(serde_json::from_str)
    .collect::<Result<_, _>>()?;
    let starts: Vec<_> = starts
        .iter()
        .filter(|row| row["requestStarted"] == true && row["sessionKind"] == "parent")
        .collect();
    assert_eq!(starts.len(), requests.len());
    let mut previous: Option<Vec<u8>> = None;
    let mut previous_tokens: Option<Vec<u32>> = None;
    let mut tokens = Vec::new();
    let mut stability = Vec::new();
    for ((body, row), start) in requests.iter().zip(&rows).zip(&starts) {
        let diagnostic = &row["prefixDiagnostics"];
        assert_eq!(start["requestId"], diagnostic["requestId"]);
        assert_eq!(diagnostic["sessionKind"], "parent");
        assert!(
            diagnostic["sessionSha256"]
                .as_str()
                .is_some_and(|value| value.len() == 64)
        );
        assert!(diagnostic["phase"].is_string());
        assert!(diagnostic["round"].is_number());
        let mut prefix = Vec::new();
        let components = diagnostic["components"].as_array().unwrap();
        for item in components {
            let field = item["component"].as_str().unwrap();
            let value = if field == "input" {
                &body["input"][usize::try_from(item["index"].as_u64().unwrap()).unwrap()]
            } else {
                &body[field]
            };
            let encoded = value.to_string();
            assert_eq!(item["bytes"], encoded.len());
            if matches!(field, "input" | "instructions") {
                assert!(item.get("sha256").is_none());
            } else {
                assert_eq!(
                    item["sha256"],
                    format!("{:x}", Sha256::digest(encoded.as_bytes()))
                );
            }
            prefix.extend_from_slice(encoded.as_bytes());
            prefix.push(b'\n');
        }
        assert_eq!(diagnostic["prefixBytes"], prefix.len());
        assert!(diagnostic.get("prefixSha256").is_none());
        assert_eq!(
            diagnostic["promptCacheKeySha256"],
            format!(
                "{:x}",
                Sha256::digest(body["prompt_cache_key"].as_str().unwrap().as_bytes())
            )
        );
        assert!(row.get("promptCacheKey").is_none());
        if let Some(previous) = &previous {
            let lcp = previous
                .iter()
                .zip(&prefix)
                .take_while(|(a, b)| a == b)
                .count();
            assert_eq!(diagnostic["lcpBytes"], lcp);
            stability.push(100.0 * lcp as f64 / previous.len() as f64);
        }
        let current_tokens = tokenizer.encode_ordinary(std::str::from_utf8(&prefix).unwrap());
        assert_eq!(diagnostic["prefixTokens"], current_tokens.len());
        if let Some(previous) = &previous_tokens {
            let lcp = previous
                .iter()
                .zip(&current_tokens)
                .take_while(|(a, b)| a == b)
                .count();
            assert_eq!(diagnostic["lcpTokens"], lcp);
            assert_eq!(
                diagnostic["lcpTokenPercent"],
                100.0 * lcp as f64 / previous.len().max(1) as f64
            );
        }
        tokens.push(current_tokens.len());
        previous_tokens = Some(current_tokens);
        previous = Some(prefix);
    }
    eprintln!(
        "{label}: {}",
        json!({"requests":requests.len(),"reconstructedInputTokensPerRequest":tokens,"lcpPercent":stability})
    );
    Ok(rows)
}
