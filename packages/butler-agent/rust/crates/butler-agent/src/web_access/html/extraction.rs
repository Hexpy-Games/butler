use dom_smoothie::{Config, Readability};

use super::{decode_entities, matching_close, parse_tags, strip_html};

pub(in crate::web_access) struct HtmlExtraction {
    pub(in crate::web_access) title: Option<String>,
    pub(in crate::web_access) text: String,
    pub(in crate::web_access) markdown: String,
    pub(in crate::web_access) method: &'static str,
}

pub(in crate::web_access) fn extract_readable_html(
    html: &str,
    document_url: &str,
) -> HtmlExtraction {
    let raw_text = compact_text(&strip_html(html));
    let article = Readability::new(html, Some(document_url), Some(Config::default()))
        .ok()
        .and_then(|mut readability| readability.parse().ok());
    if let Some(article) = article {
        let text = compact_text(&article.text_content);
        if readable_enough(&text, &raw_text) {
            return HtmlExtraction {
                markdown: markdown_from_html(&article.content),
                text,
                title: nonempty(&article.title),
                method: "readability",
            };
        }
    }
    HtmlExtraction {
        title: None,
        markdown: raw_text.clone(),
        text: raw_text,
        method: "raw-html",
    }
}

fn nonempty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn compact_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn readable_enough(candidate: &str, raw: &str) -> bool {
    let candidate = candidate.encode_utf16().count();
    let raw = raw.encode_utf16().count();
    candidate >= 200 || candidate.saturating_mul(4) >= raw
}

fn markdown_from_html(html: &str) -> String {
    let tags = parse_tags(html);
    let mut output = String::new();
    let mut cursor = 0;
    let mut links: Vec<Option<String>> = Vec::new();
    let mut pre_depth = 0_usize;
    let mut index = 0;
    while index < tags.len() {
        let tag = &tags[index];
        output.push_str(&decode_entities(&html[cursor..tag.start]));
        if !tag.closing
            && tag.name == "table"
            && let Some(close) = matching_close(&tags, index)
        {
            output.push_str("\n\n");
            output.push_str(&html[tag.start..tags[close].end]);
            output.push_str("\n\n");
            cursor = tags[close].end;
            index = close + 1;
            continue;
        }
        if !tag.closing
            && matches!(tag.name.as_str(), "script" | "style" | "noscript" | "svg")
            && let Some(close) = matching_close(&tags, index)
        {
            cursor = tags[close].end;
            index = close + 1;
            continue;
        }
        if tag.closing {
            match tag.name.as_str() {
                "a" => {
                    if let Some(Some(href)) = links.pop() {
                        output.push_str("](");
                        output.push_str(&href);
                        output.push(')');
                    }
                }
                "pre" => {
                    pre_depth = pre_depth.saturating_sub(1);
                    while output.ends_with('\n') {
                        output.pop();
                    }
                    output.push_str("\n```\n\n");
                }
                "code" if pre_depth == 0 => output.push('`'),
                "p" | "div" | "article" | "main" | "section" | "blockquote" | "ul" | "ol"
                | "li" | "tr" => output.push_str("\n\n"),
                name if super::is_heading(name) => output.push_str("\n\n"),
                "td" | "th" => output.push_str(" | "),
                _ => {}
            }
        } else {
            match tag.name.as_str() {
                "a" => {
                    let href = tag.attributes.get("href").and_then(|href| safe_link(href));
                    if href.is_some() {
                        output.push('[');
                    }
                    links.push(href);
                }
                "pre" => {
                    output.push_str("\n\n```\n");
                    pre_depth += 1;
                }
                "code" if pre_depth == 0 => output.push('`'),
                name if super::is_heading(name) => {
                    output.push_str("\n\n");
                    let level = tag.name[1..].parse::<usize>().unwrap_or(1);
                    output.push_str(&"#".repeat(level.min(6)));
                    output.push(' ');
                }
                "p" | "div" | "article" | "main" | "section" | "ul" | "ol" | "tr" => {
                    output.push_str("\n\n");
                }
                "li" => output.push_str("\n- "),
                "blockquote" => output.push_str("\n\n> "),
                "br" => output.push_str("  \n"),
                "hr" => output.push_str("\n\n---\n\n"),
                "td" | "th" => output.push_str(" | "),
                _ => {}
            }
        }
        cursor = tag.end;
        index += 1;
    }
    output.push_str(&decode_entities(&html[cursor..]));
    normalize_markdown(&output)
}

fn safe_link(value: &str) -> Option<String> {
    let link = value.trim();
    if link.starts_with('/') || link.starts_with('#') {
        return Some(link.replace(['(', ')', '\n', '\r'], ""));
    }
    let parsed = url::Url::parse(link).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return None;
    }
    Some(link.replace(['(', ')', '\n', '\r'], ""))
}

fn normalize_markdown(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut newline_count = 0;
    for ch in value.chars() {
        if ch == '\r' {
            continue;
        }
        if ch == '\n' {
            newline_count += 1;
            if newline_count <= 3 {
                output.push(ch);
            }
        } else {
            newline_count = 0;
            output.push(ch);
        }
    }
    output
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::extract_readable_html;

    #[test]
    fn article_extraction_matches_source_semantics_for_generic_content() {
        let body = format!(
            "<html><head><title>Story title</title></head><body><nav>nav-only text must be removed</nav><div class=\"ad\">ad-only text must be removed</div><div><h1>Story title</h1><p>{}</p><p>See <a href=\"https://example.com/source\">primary source</a>.</p><pre><code>let answer = 42;\n</code></pre><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody><tr><td>answer</td><td>42</td></tr></tbody></table></div><footer>footer-only text must be removed</footer></body></html>",
            "A useful article sentence. ".repeat(24),
        );
        let result = extract_readable_html(&body, "https://example.com/article");

        assert_eq!(result.method, "readability");
        assert!(!result.text.contains("nav-only"));
        assert!(!result.text.contains("ad-only"));
        assert!(!result.text.contains("footer-only"));
        assert!(
            result
                .markdown
                .contains("[primary source](https://example.com/source)")
        );
        assert!(result.markdown.contains("```\nlet answer = 42;\n```"));
        assert!(result.markdown.contains("<table>"));
        assert!(result.markdown.contains("<th>Key</th>"));
        assert!(result.markdown.contains("<tbody>"));
        assert_eq!(result.title.as_deref(), Some("Story title"));
    }
}
