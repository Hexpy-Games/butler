//! Cassettes: sanitized recordings of real provider exchanges.
//!
//! Layout: `<root>/<scenario>/<n>.json` (one exchange each, in recorded order)
//! and `<root>/<scenario>/meta.json` (provenance, per-file hashes and the
//! structural fingerprint used by drift detection). Only the recorder writes
//! these files; `lint` rejects any file whose hash differs from `meta.json`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::config::nonempty;
use super::{HarnessError, harness_error, sha256_hex};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Exchange {
    pub request: RequestRecord,
    pub response: ResponseRecord,
}

/// What the recorder keeps of a request: the match key and a structural
/// summary. The full prompt is not stored (it holds system text and paths).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RequestRecord {
    pub method: String,
    pub path: String,
    pub key: MatchKey,
}

/// Replay match key (PROVIDER_CONFIG.md §4.2, narrowed per the recorded
/// traffic): the request text between `User request:` and `Current scope:`
/// carries per-run times, hashes and ids around it, so only that span is
/// compared, after placeholder normalization.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MatchKey {
    pub path: String,
    pub model: String,
    pub effort: Option<String>,
    /// Normalized user request text (placeholders like `{{NONCE}}` kept).
    pub user_request: String,
    /// Item kinds after the last user message (tool rounds), e.g.
    /// `["function_call", "function_call_output"]`.
    pub round: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResponseRecord {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub chunks: Vec<Chunk>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Chunk {
    pub delay_ms: u64,
    pub text: String,
}

impl ResponseRecord {
    pub fn body(&self) -> String {
        self.chunks
            .iter()
            .map(|chunk| chunk.text.as_str())
            .collect()
    }

    /// The answer text the recorded stream carries: its
    /// `response.output_text.delta` deltas, concatenated as sent.
    pub fn output_text(&self) -> String {
        self.body()
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|data| serde_json::from_str::<Value>(data).ok())
            .filter(|event| event["type"] == "response.output_text.delta")
            .filter_map(|event| event["delta"].as_str().map(str::to_owned))
            .collect()
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Meta {
    pub scenario: String,
    pub provider: String,
    pub model: String,
    pub effort: Option<String>,
    pub wire_shape: String,
    pub butler_git_sha: String,
    pub recorded_at: String,
    pub recorder: String,
    pub sanitization: Vec<String>,
    pub files: Vec<FileHash>,
    /// Per exchange: ordered SSE event types and their JSON key sets.
    pub fingerprint: Vec<Vec<String>>,
    /// Cassette this one extends: its exchanges are served first, and this
    /// one holds only the requests the base had no recording for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileHash {
    pub file: String,
    pub sha256: String,
}

pub fn root() -> PathBuf {
    nonempty("BUTLER_E2E_CASSETTES")
        .map(PathBuf::from)
        .unwrap_or_else(|| super::binary::crate_root().join("cassettes"))
}

pub struct Cassette {
    pub scenario: String,
    pub meta: Meta,
    pub exchanges: Vec<Exchange>,
}

impl Cassette {
    pub fn load(scenario: &str) -> Result<Self, HarnessError> {
        load_from(&root().join(scenario), scenario)
    }

    pub fn exists(scenario: &str) -> bool {
        root().join(scenario).join("meta.json").is_file()
    }
}

pub fn load_from(dir: &Path, scenario: &str) -> Result<Cassette, HarnessError> {
    let meta_path = dir.join("meta.json");
    let meta: Meta = serde_json::from_slice(&fs::read(&meta_path).map_err(|error| {
        harness_error(format!(
            "cassette {scenario} is not recorded ({}): {error}. Record it with \
             BUTLER_E2E_RECORD=1 (see crates/butler-e2e/README.md)",
            meta_path.display()
        ))
    })?)?;
    let mut exchanges = match &meta.base {
        Some(base) => Cassette::load(base)?.exchanges,
        None => Vec::new(),
    };
    for file in &meta.files {
        let bytes = fs::read(dir.join(&file.file))?;
        if sha256_hex(&bytes) != file.sha256 {
            return Err(harness_error(format!(
                "cassette {scenario}/{} was edited outside the recorder (hash mismatch)",
                file.file
            )));
        }
        let mut exchange: Exchange = serde_json::from_slice(&bytes)?;
        exchange.request.key.user_request =
            super::matching::normalize_volatile(&exchange.request.key.user_request);
        exchanges.push(exchange);
    }
    Ok(Cassette {
        scenario: scenario.to_owned(),
        meta,
        exchanges,
    })
}

/// Writes one recorded scenario (exchanges already sanitized).
pub fn write(dir: &Path, mut meta: Meta, exchanges: &[Exchange]) -> Result<(), HarnessError> {
    if dir.exists() {
        fs::remove_dir_all(dir)?;
    }
    fs::create_dir_all(dir)?;
    meta.files.clear();
    meta.fingerprint.clear();
    for (index, exchange) in exchanges.iter().enumerate() {
        let name = format!("{index:03}.json");
        let bytes = serde_json::to_vec_pretty(exchange)?;
        fs::write(dir.join(&name), &bytes)?;
        meta.files.push(FileHash {
            file: name,
            sha256: sha256_hex(&bytes),
        });
        meta.fingerprint.push(fingerprint(&exchange.response));
    }
    fs::write(dir.join("meta.json"), serde_json::to_vec_pretty(&meta)?)?;
    Ok(())
}

/// Structural fingerprint of one response: status plus, per SSE `data:` JSON
/// event, its `type` and sorted key set (text content is ignored).
pub fn fingerprint(response: &ResponseRecord) -> Vec<String> {
    let mut out = vec![format!("status:{}", response.status)];
    let body = response.body();
    let mut any_event = false;
    for line in body.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(data.trim()) else {
            continue;
        };
        any_event = true;
        let kind = value["type"].as_str().unwrap_or("-").to_owned();
        let mut keys: Vec<_> = value
            .as_object()
            .map(|object| object.keys().cloned().collect())
            .unwrap_or_default();
        keys.sort();
        let entry = format!("{kind}{{{}}}", keys.join(","));
        if out.last() != Some(&entry) {
            out.push(entry);
        }
    }
    if !any_event && let Ok(value) = serde_json::from_str::<Value>(&body) {
        let mut keys: Vec<_> = value
            .as_object()
            .map(|object| object.keys().cloned().collect())
            .unwrap_or_default();
        keys.sort();
        out.push(format!("json{{{}}}", keys.join(",")));
    }
    out
}
