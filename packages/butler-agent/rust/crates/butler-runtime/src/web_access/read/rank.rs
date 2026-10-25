//! Pure chunk ranking. Query windows retain complete chunks and every omitted index.
use super::super::page::PageRead;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub(in crate::web_access) fn tokens(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect()
}

pub(in crate::web_access) fn result(
    page: &PageRead,
    query: &str,
    count: usize,
    start: usize,
) -> Value {
    let documents: Vec<_> = page
        .chunks
        .iter()
        .map(|chunk| tokens(&chunk.text))
        .collect();
    let terms: BTreeSet<_> = tokens(query).into_iter().collect();
    let average =
        documents.iter().map(Vec::len).sum::<usize>() as f64 / documents.len().max(1) as f64;
    let frequencies: BTreeMap<_, _> = terms
        .iter()
        .map(|term| {
            let hits = documents
                .iter()
                .filter(|words| words.contains(term))
                .count();
            (term, hits)
        })
        .collect();
    let mut scored: Vec<_> = documents
        .iter()
        .enumerate()
        .skip(start)
        .map(|(index, words)| {
            let title = tokens(page.chunks[index].title.as_deref().unwrap_or(""));
            let score = terms
                .iter()
                .map(|term| {
                    let tf = words.iter().filter(|word| *word == term).count() as f64;
                    let df = frequencies[term] as f64;
                    let idf = (1.0 + (documents.len() as f64 - df + 0.5) / (df + 0.5)).ln();
                    let length = words.len() as f64 / average.max(1.0);
                    idf * (tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * length)))
                        + if title.contains(term) { idf * 2.0 } else { 0.0 }
                })
                .sum::<f64>();
            (index, score)
        })
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let selected: Vec<_> = scored.iter().take(count).map(|(index, _)| *index).collect();
    let more: Vec<_> = (0..page.chunks.len())
        .filter(|index| !selected.contains(index))
        .collect();
    let chunks: Vec<_> = selected.iter().map(|index| &page.chunks[*index]).collect();
    let markdown = chunks
        .iter()
        .map(|chunk| chunk.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut result = super::bounded_result(page, usize::MAX, 0, start);
    result["evidence_quality"] = json!(super::evidence_quality(page, !markdown.trim().is_empty()));
    result["ranked"] = json!(true);
    result["chunks"] = json!(chunks);
    result["markdown"] = json!(markdown);
    result["returned_chunks"] = json!(selected.len());
    result["more_chunks"] = json!(more);
    result["content_has_more"] = json!(!more.is_empty());
    result["next_start_chunk"] = json!(more.first());
    result["markdown_truncated"] = json!(false);
    result["truncated"] = json!(!more.is_empty());
    result
}
