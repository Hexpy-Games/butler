use std::collections::HashSet;

use url::Url;

use super::super::{
    html::{compact, element_inner, matching_close, parse_tags, strip_html},
    providers::contracts::SearchResult,
};

pub(in crate::web_access) fn parse_results(
    html: &str,
    limit: usize,
    allowed: &[String],
    blocked: &[String],
) -> Vec<SearchResult> {
    let tags = parse_tags(html);
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    let mut index = 0;
    while index < tags.len() && results.len() < limit {
        let tag = &tags[index];
        if tag.closing || tag.name != "div" || !has_class(tag, "result") {
            index += 1;
            continue;
        }
        let Some(end_index) = matching_close(&tags, index) else {
            index += 1;
            continue;
        };
        let container_start = tag.end;
        let container_end = tags[end_index].start;
        let container = &html[container_start..container_end];
        let Some(result) = parse_result_container(container) else {
            index = end_index + 1;
            continue;
        };
        if seen.insert(result.url.clone())
            && matches_domains(&result.url, allowed)
            && (blocked.is_empty() || !matches_domains(&result.url, blocked))
        {
            results.push(result);
        }
        index = end_index + 1;
    }
    results
}

fn parse_result_container(container: &str) -> Option<SearchResult> {
    let tags = parse_tags(container);
    let (link_index, link) = tags
        .iter()
        .enumerate()
        .find(|(_, tag)| !tag.closing && tag.name == "a" && has_class(tag, "result__a"))?;
    let href = link.attributes.get("href")?;
    let url = decode_result_url(href)?;
    let title = element_inner(container, &tags, link_index)
        .map(strip_html)
        .map(|text| compact(&text))
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| url.clone());
    let snippet = tags
        .iter()
        .enumerate()
        .find(|(_, tag)| !tag.closing && has_class(tag, "result__snippet"))
        .and_then(|(index, _)| element_inner(container, &tags, index))
        .map(strip_html)
        .map(|text| compact(&text))
        .unwrap_or_default();
    let source = Url::parse(&url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))
        .map(|host| host.strip_prefix("www.").unwrap_or(&host).to_owned())
        .unwrap_or_else(|| "unknown".into());
    Some(SearchResult {
        title,
        url,
        snippet,
        source,
        published_at: None,
    })
}

fn decode_result_url(href: &str) -> Option<String> {
    let decoded = super::super::html::decode_entities(href);
    let parsed = if decoded.starts_with("//") {
        Url::parse(&format!("https:{decoded}"))
    } else if decoded.starts_with('/') {
        Url::parse(&format!("https://duckduckgo.com{decoded}"))
    } else {
        Url::parse(&decoded)
    }
    .ok()?;
    if let Some(target) = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "uddg").then(|| percent_decode(&value)))
    {
        let target = Url::parse(&target).ok()?;
        return (matches!(target.scheme(), "http" | "https")
            && target.username().is_empty()
            && target.password().is_none())
        .then(|| target.to_string());
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    if matches!(parsed.scheme(), "http" | "https")
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && host != "duckduckgo.com"
        && !host.ends_with(".duckduckgo.com")
    {
        Some(parsed.to_string())
    } else {
        None
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2]))
        {
            decoded.push(high * 16 + low);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn has_class(tag: &super::super::html::HtmlTag, class: &str) -> bool {
    tag.attributes
        .get("class")
        .is_some_and(|classes| classes.split_ascii_whitespace().any(|value| value == class))
}

fn matches_domains(url: &str, domains: &[String]) -> bool {
    if domains.is_empty() {
        return true;
    }
    let Some(host) = Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_ascii_lowercase))
    else {
        return false;
    };
    let host = host.strip_prefix("www.").unwrap_or(&host);
    domains.iter().any(|domain| {
        let domain = domain.to_ascii_lowercase();
        host == domain || host.ends_with(&format!(".{domain}"))
    })
}

pub(in crate::web_access) fn is_duckduckgo_challenge(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    (lower.contains("id=\"challenge-form\"") || lower.contains("id='challenge-form'"))
        || (lower.contains("anomaly-modal")
            && (lower.contains("class=\"") || lower.contains("class='")))
        || lower.contains("/anomaly.js?")
        || lower.contains("/anomaly.js\"")
        || lower.contains("/anomaly.js'")
}

#[cfg(test)]
mod tests {
    use super::{decode_result_url, parse_results};

    #[test]
    fn parses_duckduckgo_result_and_redirect_link() {
        let html = r#"<div class="result results_links"><div class="result__body"><h2><a class="result__a" href="/l/?uddg=https%253A%252F%252Fexample.com%252Fnews">Example &amp; News</a></h2><a class="result__snippet">A <b>public</b> snippet.</a></div></div>"#;
        let results = parse_results(html, 5, &[], &[]);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Example & News");
        assert_eq!(results[0].url, "https://example.com/news");
        assert_eq!(results[0].snippet, "A public snippet.");
        assert_eq!(
            decode_result_url("https://duckduckgo.com/?uddg=https%3A%2F%2Fexample.com"),
            Some("https://example.com/".into())
        );
    }

    #[test]
    fn applies_allowed_and_blocked_domain_filters() {
        let html = r#"<div class="result"><a class="result__a" href="https://news.example.com/a">A</a><div class="result__snippet">a</div></div><div class="result"><a class="result__a" href="https://other.test/b">B</a></div>"#;
        let results = parse_results(html, 5, &["example.com".into()], &[]);
        assert_eq!(
            results
                .iter()
                .map(|row| row.url.as_str())
                .collect::<Vec<_>>(),
            ["https://news.example.com/a"]
        );
        assert!(
            parse_results(html, 5, &[], &["example.com".into()])
                .iter()
                .all(|row| row.url == "https://other.test/b")
        );
    }
}
