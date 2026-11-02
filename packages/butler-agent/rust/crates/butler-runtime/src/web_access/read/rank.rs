//! BM25 passage selection over the page's cached sentence/list/row units.
use super::super::page::PageRead;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub(in crate::web_access) fn tokens(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect()
}

#[derive(Clone)]
struct Passage {
    chunk: usize,
    start: usize,
    end: usize,
    score: f64,
}

pub(in crate::web_access) fn result(
    page: &PageRead,
    query: &str,
    count: usize,
    start: usize,
    max_chars: usize,
) -> Value {
    let ranked = ranked(page, query);
    let mut returned = Vec::new();
    let mut used = 0;
    for passage in ranked.iter().skip(start).take(count) {
        let text =
            super::passages::slice(&page.chunks[passage.chunk].text, passage.start, passage.end);
        let size = text.encode_utf16().count();
        if used + size > max_chars {
            break;
        }
        used += size;
        returned
            .push(json!({"text":text,"chunk":passage.chunk,"span":[passage.start,passage.end]}));
    }
    let next = start.saturating_add(returned.len());
    let more = next < ranked.len();
    returned.sort_by_key(|p| (p["chunk"].as_u64(), p["span"][0].as_u64()));
    let markdown = returned
        .iter()
        .filter_map(|p| p["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut result = super::bounded_result(page, max_chars, 0, start);
    result["evidence_quality"] = json!(super::evidence_quality(page, !returned.is_empty()));
    result["ranked"] = json!(true);
    result["passages"] = json!(returned);
    // The durable result retains the ordinary text field for exact retrieval;
    // the provider projection shows passages only.
    result["markdown"] = json!(markdown);
    result["chunks"] = json!([]);
    result["returned_chunks"] = json!(returned.len());
    result["content_has_more"] = json!(more);
    result["next_start_chunk"] = json!(more.then_some(next));
    result["markdown_truncated"] = json!(false);
    result["truncated"] = json!(more);
    result
}

fn ranked(page: &PageRead, query: &str) -> Vec<Passage> {
    let terms: BTreeSet<_> = tokens(query).into_iter().collect();
    let documents: Vec<_> = page.chunks.iter().flat_map(|c| &c.units).collect();
    let average = documents.iter().map(|u| u.words.len()).sum::<usize>() as f64
        / documents.len().max(1) as f64;
    let frequencies: BTreeMap<_, _> = terms
        .iter()
        .map(|term| {
            (
                term,
                documents.iter().filter(|u| u.words.contains(term)).count(),
            )
        })
        .collect();
    let mut merged: Vec<Passage> = Vec::new();
    for (chunk_index, chunk) in page.chunks.iter().enumerate() {
        let title = tokens(chunk.title.as_deref().unwrap_or(""));
        for (index, unit) in chunk.units.iter().enumerate() {
            let score = score(&unit.words, &title, &frequencies, documents.len(), average);
            if score <= 0.0 {
                continue;
            }
            let start = chunk.units[index.saturating_sub(1)].start;
            let end = chunk.units[(index + 1).min(chunk.units.len() - 1)].end;
            let start = if chunk.header_prefix {
                0
            } else {
                table_header_start(&chunk.text, start)
            };
            if let Some(previous) = merged.last_mut()
                && previous.chunk == chunk_index
                && start <= previous.end + 2
            {
                previous.end = previous.end.max(end);
                previous.score = previous.score.max(score);
            } else {
                merged.push(Passage {
                    chunk: chunk_index,
                    start,
                    end,
                    score,
                });
            }
        }
    }
    merged.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| (a.chunk, a.start).cmp(&(b.chunk, b.start)))
    });
    merged
}

fn score(
    words: &[String],
    title: &[String],
    frequencies: &BTreeMap<&String, usize>,
    total: usize,
    average: f64,
) -> f64 {
    frequencies
        .iter()
        .map(|(term, df)| {
            let tf = words.iter().filter(|w| w == term).count() as f64;
            let df = *df as f64;
            let idf = (1.0 + (total as f64 - df + 0.5) / (df + 0.5)).ln();
            let length = words.len() as f64 / average.max(1.0);
            idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * length))
                + if tf > 0.0 && title.contains(term) {
                    idf * 2.0
                } else {
                    0.0
                }
        })
        .sum()
}

fn table_header_start(text: &str, start: usize) -> usize {
    let prefix = super::passages::slice(text, 0, start);
    if let Some(table) = prefix.rfind("<table")
        && !prefix[table..].contains("</table>")
    {
        return prefix[..table].chars().count();
    }
    let mut offset = 0;
    let mut header = start;
    for line in prefix.split_inclusive('\n') {
        if line.trim_start().starts_with('|') {
            if header == start {
                header = offset;
            }
        } else {
            header = start;
        }
        offset += line.chars().count();
    }
    header
}
