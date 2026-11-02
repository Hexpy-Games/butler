//! Prepared once alongside chunks; spans count Unicode scalar characters.
use serde::{Deserialize, Serialize};
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(in crate::web_access) struct Unit {
    pub start: usize,
    pub end: usize,
    pub words: Vec<String>,
}

pub(in crate::web_access) fn prepare(text: &str) -> Vec<Unit> {
    let mut units = Vec::new();
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start();
        let item = trimmed.starts_with("- ")
            || trimmed.starts_with("* ")
            || trimmed
                .split_once(". ")
                .is_some_and(|(n, _)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()));
        let row = trimmed.starts_with('|') || trimmed.contains("<tr>");
        let parts: Vec<_> = if item || row {
            vec![line]
        } else {
            line.split_sentence_bounds().collect()
        };
        for sentence in parts {
            let trimmed = sentence.trim();
            let start = offset + sentence.chars().take_while(|c| c.is_whitespace()).count();
            let end = start + trimmed.chars().count();
            if !trimmed.is_empty() {
                units.push(Unit {
                    start,
                    end,
                    words: super::rank::tokens(trimmed),
                });
            }
            offset += sentence.chars().count();
        }
    }
    units
}

pub(in crate::web_access) fn slice(text: &str, start: usize, end: usize) -> String {
    text.chars().skip(start).take(end - start).collect()
}
