use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

use regex::Regex;
use unicode_normalization::UnicodeNormalization;

use super::clamp01;
use crate::cognition::legacy_recall::types::LegacyRecallCandidate;

const RECALL_SEED_MIN_CHARS: usize = 2;
const RECALL_SEED_MAX_TERMS: usize = 24;
const NON_ASCII_LEXICAL_SHINGLE_MIN_CHARS: usize = 2;
const NON_ASCII_LEXICAL_SHINGLE_MAX_CHARS: usize = 3;
const BM25_IDF_SMOOTHING: f64 = 0.5;
const BM25_TERM_FREQUENCY_SATURATION_K1: f64 = 1.2;
const BM25_DOCUMENT_LENGTH_NORMALIZATION_B: f64 = 0.75;
const LEXICAL_SEED_COVERAGE_EXPONENT: i32 = 4;

static TOKEN_SPLIT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}._-]+").expect("constant recall token regex"));
static LETTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\p{L}").expect("constant Unicode letter regex"));

#[derive(Default)]
pub(super) struct LexicalStats {
    query_terms: Vec<String>,
    query_seed_terms: Vec<Vec<String>>,
    document_frequency: HashMap<String, usize>,
    average_document_length: f64,
    document_count: usize,
}

pub(super) struct LexicalScore {
    pub score: f64,
    pub matched_seed_count: usize,
}

pub(super) fn extract_recall_seeds(cue: &str) -> Vec<String> {
    unique(
        TOKEN_SPLIT
            .split(&cue.to_lowercase())
            .filter(|part| utf16_len(part) >= RECALL_SEED_MIN_CHARS)
            .map(str::to_owned),
    )
    .into_iter()
    .take(RECALL_SEED_MAX_TERMS)
    .collect()
}

pub(super) fn lexical_tokens(text: &str) -> Vec<String> {
    let normalized = text.nfc().collect::<String>().to_lowercase();
    let mut tokens = Vec::new();
    for token in TOKEN_SPLIT.split(&normalized) {
        if utf16_len(token) < RECALL_SEED_MIN_CHARS {
            continue;
        }
        tokens.push(token.to_owned());
        tokens.extend(non_ascii_lexical_shingles(token));
    }
    unique(tokens)
}

fn non_ascii_lexical_shingles(token: &str) -> Vec<String> {
    if !token.chars().any(|character| character as u32 > 0x7f) || !LETTER.is_match(token) {
        return Vec::new();
    }
    let characters = token.chars().collect::<Vec<_>>();
    let mut shingles = Vec::new();
    for size in NON_ASCII_LEXICAL_SHINGLE_MIN_CHARS..=NON_ASCII_LEXICAL_SHINGLE_MAX_CHARS {
        if characters.len() < size {
            continue;
        }
        for index in 0..=characters.len() - size {
            shingles.push(characters[index..index + size].iter().collect());
        }
    }
    shingles
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

pub(super) fn build_lexical_stats(
    candidates: &[LegacyRecallCandidate],
    seeds: &[String],
) -> LexicalStats {
    let query_seed_terms = seeds
        .iter()
        .map(|seed| lexical_tokens(seed))
        .filter(|terms| !terms.is_empty())
        .collect::<Vec<_>>();
    let query_terms = unique(query_seed_terms.iter().flatten().cloned());
    let mut document_frequency = HashMap::new();
    let mut total_document_length = 0usize;
    for candidate in candidates {
        let document_tokens = lexical_tokens(&format!("{}\n{}", candidate.summary, candidate.text));
        total_document_length += document_tokens.len();
        let unique_document_tokens = document_tokens
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        for term in &query_terms {
            if unique_document_tokens.contains(term.as_str()) {
                *document_frequency.entry(term.clone()).or_insert(0) += 1;
            }
        }
    }
    LexicalStats {
        query_terms,
        query_seed_terms,
        document_frequency,
        average_document_length: if candidates.is_empty() {
            0.0
        } else {
            total_document_length as f64 / candidates.len() as f64
        },
        document_count: candidates.len(),
    }
}

pub(super) fn lexical_score(
    candidate: &LegacyRecallCandidate,
    stats: &LexicalStats,
) -> LexicalScore {
    if stats.query_terms.is_empty() || stats.document_count == 0 {
        return LexicalScore {
            score: 0.0,
            matched_seed_count: 0,
        };
    }
    let tokens = lexical_tokens(&format!("{}\n{}", candidate.summary, candidate.text));
    if tokens.is_empty() {
        return LexicalScore {
            score: 0.0,
            matched_seed_count: 0,
        };
    }
    let mut frequencies = HashMap::<String, usize>::new();
    for token in &tokens {
        *frequencies.entry(token.clone()).or_insert(0) += 1;
    }
    let average_length = if stats.average_document_length > 0.0 {
        stats.average_document_length
    } else {
        tokens.len() as f64
    };
    let mut score = 0.0;
    let mut available_query_weight = 0.0;
    for term in &stats.query_terms {
        let term_idf = inverse_document_frequency(term, stats);
        if term_idf <= 0.0 {
            continue;
        }
        available_query_weight += term_idf;
        let term_frequency = frequencies.get(term).copied().unwrap_or(0) as f64;
        if term_frequency == 0.0 {
            continue;
        }
        let length_normalization = BM25_TERM_FREQUENCY_SATURATION_K1
            * (1.0 - BM25_DOCUMENT_LENGTH_NORMALIZATION_B
                + BM25_DOCUMENT_LENGTH_NORMALIZATION_B * (tokens.len() as f64 / average_length));
        score += term_idf
            * ((term_frequency * (BM25_TERM_FREQUENCY_SATURATION_K1 + 1.0))
                / (term_frequency + length_normalization));
    }
    if available_query_weight <= 0.0 {
        return LexicalScore {
            score: 0.0,
            matched_seed_count: 0,
        };
    }
    let matched_seed_count = stats
        .query_seed_terms
        .iter()
        .filter(|terms| {
            terms
                .iter()
                .any(|term| frequencies.get(term).copied().unwrap_or(0) > 0)
        })
        .count();
    let seed_coverage = if stats.query_seed_terms.is_empty() {
        0.0
    } else {
        matched_seed_count as f64 / stats.query_seed_terms.len() as f64
    };
    let coverage = seed_coverage.powi(LEXICAL_SEED_COVERAGE_EXPONENT);
    LexicalScore {
        score: clamp01((score / available_query_weight) * coverage),
        matched_seed_count,
    }
}

fn inverse_document_frequency(term: &str, stats: &LexicalStats) -> f64 {
    let frequency = stats.document_frequency.get(term).copied().unwrap_or(0);
    if frequency == 0 || stats.document_count == 0 {
        return 0.0;
    }
    (1.0 + (stats.document_count as f64 - frequency as f64 + BM25_IDF_SMOOTHING)
        / (frequency as f64 + BM25_IDF_SMOOTHING))
        .ln()
}
