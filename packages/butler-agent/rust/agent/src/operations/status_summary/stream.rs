//! Small, read-only streaming JSONL primitive shared by status projections.

use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
};

use serde_json::Value;

pub(super) fn visit_jsonl(path: &Path, mut visit: impl FnMut(&str, Result<Value, ()>)) -> usize {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return 0,
    };
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut parse_errors = 0;
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let text = String::from_utf8_lossy(&line);
                let text = text.trim();
                if text.is_empty() {
                    continue;
                }
                let value = serde_json::from_str::<Value>(text).map_err(|_| ());
                if value.is_err() {
                    parse_errors += 1;
                }
                visit(text, value);
            }
        }
    }
    parse_errors
}

pub(super) fn number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

pub(super) fn unsigned_count(value: Option<&Value>) -> Option<u64> {
    value.and_then(|value| {
        value.as_u64().or_else(|| {
            let number = value.as_f64()?;
            (number.is_finite()
                && number >= 0.0
                && number.fract() == 0.0
                && number < u64::MAX as f64)
                .then_some(crate::json::saturating_u64(number))
        })
    })
}
