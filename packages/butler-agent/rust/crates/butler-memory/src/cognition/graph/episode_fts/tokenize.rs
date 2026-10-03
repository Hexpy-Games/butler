//! Language-neutral words and character bigrams, shared by writes and queries.
use std::collections::BTreeSet;
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

fn tokens(text: &str, unigrams: bool) -> BTreeSet<String> {
    let normalized = crate::cognition::lexical::case_fold(&text.nfkc().collect::<String>());
    let mut tokens = BTreeSet::new();
    let mut run = String::new();
    let mut ideographic = false;
    for c in normalized.chars() {
        let cjk = is_cjk(c);
        if c.is_alphanumeric() || is_combining_mark(c) {
            if !run.is_empty() && cjk != ideographic && !is_combining_mark(c) {
                emit(&mut tokens, &mut run, ideographic, unigrams);
            }
            if run.is_empty() {
                ideographic = cjk;
            }
            run.push(c);
        } else {
            emit(&mut tokens, &mut run, ideographic, unigrams);
        }
    }
    emit(&mut tokens, &mut run, ideographic, unigrams);
    tokens
}

fn emit(tokens: &mut BTreeSet<String>, run: &mut String, cjk: bool, unigrams: bool) {
    if run.is_empty() {
        return;
    }
    tokens.insert(run.clone());
    if cjk {
        let chars = run.chars().collect::<Vec<_>>();
        for (left, right) in chars.iter().zip(chars.iter().skip(1)) {
            tokens.insert(format!("cjk{:x}x{:x}", *left as u32, *right as u32));
        }
        // Single-character cues can match a character within a longer run.
        if unigrams {
            for c in chars {
                tokens.insert(format!("uni{:x}", c as u32));
            }
        }
    }
    run.clear();
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x11ff | 0x2e80..=0x2fff | 0x3040..=0x30ff |
        0x3130..=0x318f | 0x31a0..=0x31bf | 0x31f0..=0x31ff |
        0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xa960..=0xa97f |
        0xac00..=0xd7ff | 0xf900..=0xfaff | 0xff66..=0xff9d |
        0x20000..=0x323af)
}

pub(super) fn field(text: &str) -> String {
    tokens(text, true).into_iter().collect::<Vec<_>>().join(" ")
}

pub(super) fn query(text: &str) -> String {
    let normalized = crate::cognition::lexical::case_fold(&text.nfkc().collect::<String>());
    let unigrams = normalized.chars().filter(|c| is_cjk(*c)).count() == 1;
    let tokens = tokens(text, unigrams);
    tokens
        .into_iter()
        .map(|token| format!("\"{token}\""))
        .collect::<Vec<_>>()
        .join(" OR ")
}
