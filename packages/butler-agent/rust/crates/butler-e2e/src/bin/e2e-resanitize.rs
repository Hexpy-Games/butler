//! Re-applies the recorder's sanitization to committed cassettes after the
//! sanitizer learned a new rule, so real recordings need not be made again:
//! `cargo run -p butler-e2e --bin e2e-resanitize -- USE-02 USE-04`.
//!
//! Each body is sanitized as of its recording time (`meta.recorded_at`),
//! written through the recorder's writer (fresh hashes and fingerprint) and
//! the cassette's `sanitization` list notes the pass.

use std::process::ExitCode;

use butler_e2e::e2e::cassette::{self, Cassette};
use butler_e2e::e2e::sanitize::{Placeholders, sanitize_body_at};
use butler_e2e::e2e::{HarnessError, harness_error};

fn resanitize(scenario: &str) -> Result<(), HarnessError> {
    let loaded = Cassette::load(scenario)?;
    if loaded.meta.base.is_some() {
        return Err(harness_error(format!(
            "{scenario} extends another cassette; re-record it instead"
        )));
    }
    let recorded_ms = chrono::DateTime::parse_from_rfc3339(&loaded.meta.recorded_at)
        .map_err(|error| harness_error(format!("{scenario}: recorded_at: {error}")))?
        .timestamp_millis();
    let placeholders = Placeholders::default();
    let mut exchanges = loaded.exchanges;
    for exchange in &mut exchanges {
        for chunk in &mut exchange.response.chunks {
            chunk.text = sanitize_body_at(&chunk.text, &placeholders, recorded_ms);
        }
    }
    let mut meta = loaded.meta;
    let note = "re-sanitized by e2e-resanitize: reset times -> relative placeholders";
    if !meta.sanitization.iter().any(|entry| entry == note) {
        meta.sanitization.push(note.to_owned());
    }
    cassette::write(&cassette::root().join(scenario), meta, &exchanges)
}

fn main() -> ExitCode {
    let mut status = ExitCode::SUCCESS;
    for scenario in std::env::args().skip(1) {
        match resanitize(&scenario) {
            Ok(()) => println!("re-sanitized {scenario}"),
            Err(error) => {
                eprintln!("{scenario}: {error}");
                status = ExitCode::FAILURE;
            }
        }
    }
    status
}
