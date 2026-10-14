//! Dev-only process adapter for the runtime's standalone answer contract.
#[path = "answer_blocks/stream.rs"]
mod stream;
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
    #[serde(default)]
    stream: bool,
    #[serde(default)]
    perf: bool,
    #[serde(default)]
    raw: Option<String>,
    #[serde(default)]
    prefix: usize,
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
            if request.perf {
                return Ok(stream::perf(&context));
            }
            if request.stream {
                return Ok(stream::verify(
                    &request.spec,
                    request.raw.as_deref(),
                    request.prefix,
                    &context,
                ));
            }
            Ok(match validate_answer_blocks(&request.spec, &context) {
                Ok(()) => json!({"ok": true}),
                Err(problems) => json!({"ok": false, "problems": problems}),
            })
        })
        .collect();
    println!("{}", serde_json::to_string(&results?)?);
    Ok(())
}
