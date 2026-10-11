//! Frozen Script15 analysis shared by writes and queries in one FTS index.
use std::collections::BTreeSet;
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};
use unicode_script::{Script, UnicodeScript};

const STOP: &[&str] = &[
    "그",
    "그때",
    "그거",
    "내가",
    "우리가",
    "뭐",
    "어떤",
    "어떻게",
    "언제",
    "어디",
    "다시",
    "했던",
    "했었지",
    "했지",
    "좀",
    "알려줘",
    "찾아줘",
    "있던",
    "있었던",
];

fn runs(text: &str) -> Vec<(String, Script)> {
    let mut words = Vec::new();
    let mut seen = BTreeSet::new();
    let mut run = String::new();
    let mut previous = Script::Common;
    for c in text.chars() {
        let mark = is_combining_mark(c);
        let kind = if mark && !run.is_empty() {
            previous
        } else {
            c.script()
        };
        if !c.is_alphanumeric() && !mark || !run.is_empty() && kind != previous {
            if !run.is_empty() && seen.insert(run.clone()) {
                words.push((std::mem::take(&mut run), previous));
            }
            run.clear();
        }
        if c.is_alphanumeric() || mark {
            run.push(c);
            previous = kind;
        }
    }
    if !run.is_empty() && seen.insert(run.clone()) {
        words.push((run, previous));
    }
    words
}

fn tokens(text: &str, query: bool) -> Vec<String> {
    let normalized = crate::cognition::lexical::case_fold(&text.nfkc().collect::<String>());
    let single = normalized.chars().filter(|c| grams(c.script())).count() == 1;
    let mut tokens = Vec::new();
    for (mut run, kind) in runs(&normalized) {
        let chars = run.chars().collect::<Vec<_>>();
        if kind == Script::Hangul
            && (STOP.contains(&run.as_str()) || chars.len() < 2)
            && (!single || !query)
        {
            if !query {
                unigrams(&mut tokens, &chars);
            }
            continue;
        }
        if matches!(kind, Script::Latin | Script::Cyrillic | Script::Greek) {
            run = run.nfd().filter(|c| !is_combining_mark(*c)).collect();
        }
        tokens.push(run);
        if grams(kind) {
            // Distinct words retain repeated bigrams, matching research ko2 weighting.
            for (left, right) in chars.iter().zip(chars.iter().skip(1)) {
                tokens.push(format!("cjk{:x}x{:x}", *left as u32, *right as u32));
            }
            if !query || single {
                unigrams(&mut tokens, &chars);
            }
        }
    }
    tokens
}

fn unigrams(tokens: &mut Vec<String>, chars: &[char]) {
    tokens.extend(chars.iter().map(|c| format!("uni{:x}", *c as u32)));
}

fn grams(kind: Script) -> bool {
    matches!(
        kind,
        Script::Hangul
            | Script::Han
            | Script::Hiragana
            | Script::Katakana
            | Script::Thai
            | Script::Lao
            | Script::Khmer
            | Script::Myanmar
            | Script::Tibetan
            | Script::Tai_Le
            | Script::New_Tai_Lue
            | Script::Tai_Tham
            | Script::Tai_Viet
            | Script::Balinese
            | Script::Javanese
            | Script::Sundanese
    )
}

pub(in crate::cognition) fn field(text: &str) -> String {
    tokens(text, false).join(" ")
}

pub(in crate::cognition) fn query(text: &str) -> String {
    tokens(text, true)
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|token| format!("\"{token}\""))
        .collect::<Vec<_>>()
        .join(" OR ")
}

#[cfg(test)]
pub(in crate::cognition) fn assert_frozen_analysis() {
    assert_eq!(field("CAFÉ café STRAßE forêt"), "cafe strasse foret");
    assert_eq!(field("ΆΛΦΑ ЙЁ"), "αλφα ие");
    let repeated = format!("cjk{:x}x{:x}", '청' as u32, '자' as u32);
    assert_eq!(
        field("청자 청자 청자를")
            .split_whitespace()
            .filter(|t| *t == repeated)
            .count(),
        2
    );
    assert!(!query("그때 내가 청자").contains("그때"));
    assert!(query("청").contains(&format!("uni{:x}", '청' as u32)));
    assert!(field("ภาษาไทย").contains(&format!("cjk{:x}x{:x}", 'ภ' as u32, 'า' as u32)));
    assert_eq!(query("청자Azure비밀번호"), query("청자 azure 비밀번호"));
}
