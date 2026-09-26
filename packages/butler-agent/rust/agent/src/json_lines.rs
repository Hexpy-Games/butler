//! Streaming JSONL visitor with a fixed per-line memory ceiling.

use std::{fs::File, io::BufRead, io::BufReader, path::Path};

use serde_json::Value;

pub(crate) const MAX_JSON_LINE_BYTES: usize = 1024 * 1024;

#[derive(Default)]
pub(crate) struct JsonLineVisit {
    pub(crate) oversize_lines: u64,
}

pub(crate) fn visit_json_lines(path: &Path, mut visit: impl FnMut(&Value)) -> JsonLineVisit {
    let Ok(file) = File::open(path) else {
        return JsonLineVisit::default();
    };
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut oversize = false;
    let mut outcome = JsonLineVisit::default();
    loop {
        let Ok(buffer) = reader.fill_buf() else {
            break;
        };
        if buffer.is_empty() {
            if !line.is_empty()
                && !oversize
                && let Ok(value) = serde_json::from_slice(&line)
            {
                visit(&value);
            }
            break;
        }
        let end = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(buffer.len(), |index| index + 1);
        let chunk = &buffer[..end];
        if !oversize {
            if line.len().saturating_add(chunk.len()) <= MAX_JSON_LINE_BYTES {
                line.extend_from_slice(chunk.strip_suffix(b"\n").unwrap_or(chunk));
            } else {
                line.clear();
                oversize = true;
                outcome.oversize_lines += 1;
            }
        }
        let ended = chunk.last() == Some(&b'\n');
        reader.consume(end);
        if ended {
            if !oversize && let Ok(value) = serde_json::from_slice(&line) {
                visit(&value);
            }
            line.clear();
            oversize = false;
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_oversize_line_and_continues_with_bounded_buffer() {
        let path = std::env::temp_dir().join(format!("butler-json-lines-{}", uuid::Uuid::new_v4()));
        let mut bytes = vec![b'x'; MAX_JSON_LINE_BYTES + 1];
        bytes.extend_from_slice(b"\n{\"kept\":true}\n");
        std::fs::write(&path, bytes).unwrap();
        let mut kept = false;
        let outcome = visit_json_lines(&path, |value| kept = value["kept"] == true);
        assert_eq!(outcome.oversize_lines, 1);
        assert!(kept);
        let _ = std::fs::remove_file(path);
    }
}
