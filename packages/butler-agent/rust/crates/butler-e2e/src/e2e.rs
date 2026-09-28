//! Harness facade. See the crate docs and `README.md`.

pub mod agent;
pub mod binary;
pub mod cassette;
pub mod config;
pub mod events;
pub mod faults;
pub mod fixtures;
pub mod gateway;
pub mod live;
pub mod matching;
pub mod media;
pub mod provider;
pub mod sandbox;
pub mod sanitize;
pub mod scenario;
pub mod stop_intent;

use sha2::{Digest, Sha256};

/// A failure of the harness itself (setup, strict-replay miss, missing
/// cassette), as opposed to a product assertion failure.
pub struct HarnessError(pub String);

impl std::fmt::Debug for HarnessError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "HARNESS_ERROR: {}", self.0)
    }
}

impl std::fmt::Display for HarnessError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "HARNESS_ERROR: {}", self.0)
    }
}

impl std::error::Error for HarnessError {}

pub fn harness_error(message: impl Into<String>) -> HarnessError {
    HarnessError(message.into())
}

impl From<std::io::Error> for HarnessError {
    fn from(error: std::io::Error) -> Self {
        Self(format!("io: {error}"))
    }
}

impl From<serde_json::Error> for HarnessError {
    fn from(error: serde_json::Error) -> Self {
        Self(format!("json: {error}"))
    }
}

impl From<reqwest::Error> for HarnessError {
    fn from(error: reqwest::Error) -> Self {
        Self(format!("http: {error}"))
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

/// A per-run random token the provider recording cannot contain.
pub fn nonce() -> String {
    format!("N{}", &uuid::Uuid::new_v4().simple().to_string()[..10])
}
