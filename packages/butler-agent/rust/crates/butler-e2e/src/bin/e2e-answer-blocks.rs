//! Dev-only process adapter for the runtime's standalone answer contract.
use std::{collections::HashSet, io::Read};

use butler_runtime::capabilities::answer_blocks::{AnswerBlocksContext, validate_answer_blocks};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Request {
    spec: Value,
    now: String,
    images: HashSet<String>,
    sources: Vec<String>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let requests: Vec<Request> = serde_json::from_str(&input)?;
    let results: Result<Vec<_>, chrono::ParseError> = requests
        .iter()
        .map(|request| {
            let exists = |id: &str| request.images.contains(id);
            let context = AnswerBlocksContext {
                now: DateTime::parse_from_rfc3339(&request.now)?.with_timezone(&Utc),
                image_exists: &exists,
                read_sources: &request.sources,
            };
            Ok(match validate_answer_blocks(&request.spec, &context) {
                Ok(()) => json!({"ok": true}),
                Err(problems) => json!({"ok": false, "problems": problems}),
            })
        })
        .collect();
    println!("{}", serde_json::to_string(&results?)?);
    Ok(())
}
