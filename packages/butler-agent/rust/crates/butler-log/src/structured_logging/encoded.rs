//! Producer-owned encoding; the writer only fills clock and body-reference fields.
use super::{Config, Preset, Record, redaction};
use sha2::{Digest, Sha256};
use std::{io, ops::Range};

pub(super) struct Encoded {
    pub line: Vec<u8>,
    pub body: Option<Vec<u8>>,
    pub level: String,
    pub category: String,
    pub ts: String,
    timestamp: Range<usize>,
    content_start: usize,
}
impl Encoded {
    pub(super) fn new(mut row: Record, config: &Config) -> io::Result<Self> {
        row.level.make_ascii_uppercase();
        let mut body = None;
        let mut inline = None;
        if let Some(content) = row.content.take() {
            let bytes = serde_json::to_vec(&content)?;
            row.content_len = Some(bytes.len());
            row.content_hash = Some(format!("{:x}", Sha256::digest(&bytes))[..8].into());
            if config.level == Preset::Full {
                let content = redaction::redact_json(&content);
                let bytes = serde_json::to_vec(&content)?;
                if bytes.len() > 8192 {
                    body = Some(bytes);
                } else {
                    inline = Some(serde_json::to_vec(&redaction::scrub_value(&content, true))?);
                }
            }
        }
        if body.is_some() {
            row.body_ref = None;
        }
        scrub(&mut row);
        let ts_len = serde_json::to_vec(&row.ts)?.len();
        let mut line = serde_json::to_vec(&row)?;
        line.pop();
        let content_start = line.len();
        if let Some(inline) = inline {
            line.extend_from_slice(b",\"content\":");
            line.extend(inline);
        }
        line.push(b'}');
        Ok(Self {
            line,
            body,
            level: row.level,
            category: row.category,
            ts: row.ts,
            timestamp: 6..6 + ts_len,
            content_start,
        })
    }
    pub(super) fn bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.line.capacity()
            + self.body.as_ref().map_or(0, Vec::capacity)
            + self.ts.capacity()
            + self.level.capacity()
            + self.category.capacity()
    }
    pub(super) fn finish(
        &mut self,
        last_ts: &str,
        full: bool,
        reference: Option<&str>,
    ) -> io::Result<Record> {
        if !full {
            self.line.truncate(self.content_start);
            self.line.push(b'}');
        }
        if let Some(reference) = reference {
            self.line.pop();
            self.line.extend_from_slice(b",\"body_ref\":");
            serde_json::to_writer(&mut self.line, reference)?;
            self.line.push(b'}');
        }
        if self.ts.as_str() < last_ts {
            self.line
                .splice(self.timestamp.clone(), serde_json::to_vec(last_ts)?);
        }
        let row = serde_json::from_slice(&self.line)?;
        self.line.push(b'\n');
        Ok(row)
    }
}
fn scrub(row: &mut Record) {
    for text in [
        &mut row.ts,
        &mut row.level,
        &mut row.process,
        &mut row.category,
        &mut row.event,
        &mut row.msg,
    ] {
        *text = redaction::bounded(
            &redaction::redact_log_line(text).replace("[redacted]", "[REDACTED]"),
        );
    }
    for text in [
        &mut row.trace_id,
        &mut row.span_id,
        &mut row.parent_span_id,
        &mut row.chat_id,
        &mut row.turn_id,
        &mut row.content_hash,
        &mut row.body_ref,
    ]
    .into_iter()
    .flatten()
    {
        *text = redaction::bounded(
            &redaction::redact_log_line(text).replace("[redacted]", "[REDACTED]"),
        );
    }
    row.attrs = redaction::scrub_value(&row.attrs, true);
    if let Some(error) = &mut row.error {
        *error = redaction::scrub_value(error, true);
    }
}
