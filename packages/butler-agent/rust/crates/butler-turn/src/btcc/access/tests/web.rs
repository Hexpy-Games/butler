use super::super::{web_read_carries_data, web_search_carries_data};

pub(super) fn boundaries() {
    for (url, carries) in [
        ("https://example.com/news", false),
        ("https://example.com/?q=note", true),
        ("https://example.com/#note", true),
        ("https://user@example.com/", true),
        ("https://example.com/abcdefghijklmnopqrstuvwx", true),
        ("https://example.com/.abcdefghijklmnopqrstuvw", false),
        ("https://example.com/000000000000000000000000", true),
        ("https://example.com/abcdefghijkl/mnopqrstuvwx", false),
        (
            "https://en.wikipedia.org/wiki/Rust_programming_language",
            false,
        ),
        ("https://example.com/docs/readable-deep.link_slug", false),
        (
            "https://example.com/readable_words-joined.with_separators",
            false,
        ),
        (
            "https://example.com/aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7b",
            true,
        ),
        ("https://example.com/ZXh0ZXJuYWwtY29udGVudA==", true),
        ("https://example.com/Rust_programming_language_2026", false),
        ("https://aGVsbG8td29ybGQtZXhmaWx0cmF0ZQ.example.com/", true),
        ("https://docs.example-company.co.kr/guide", false),
    ] {
        assert_eq!(web_read_carries_data(url, false), carries, "{url}");
        assert!(!web_read_carries_data(url, true), "provenance: {url}");
    }
    let query_url = format!("https://example.com/?q={}", "x".repeat(30));
    assert!(web_read_carries_data(&query_url, false));
    assert!(!web_read_carries_data(&query_url, true));
    assert!(web_read_carries_data(
        &format!("https://example.com/?q={}", "x".repeat(130)),
        false
    ));
    assert!(web_search_carries_data(&"x ".repeat(65)));
    let long_path = format!("https://example.com/{}", ".".repeat(40));
    assert!(web_read_carries_data(&long_path, false));
    assert!(!web_read_carries_data(
        &long_path.replace(&".".repeat(40), &".".repeat(39)),
        false
    ));
    assert!(!web_search_carries_data(&"x ".repeat(59)));
    assert!(web_search_carries_data(&"x ".repeat(60)));
    assert!(!web_search_carries_data(&"가".repeat(23)));
    assert!(web_search_carries_data(&"가".repeat(24)));
    search_syntax_boundaries();
}

/// Public search syntax is not data; opaque tokens and pasted text still are.
fn search_syntax_boundaries() {
    let sites = (1..=8)
        .map(|n| format!("site:museum{n}.example.org"))
        .collect::<Vec<_>>()
        .join(" OR ");
    let keywords = (1..=12)
        .map(|n| format!("\"opening hours {n}\""))
        .collect::<Vec<_>>()
        .join(" OR ");
    let prose = "the quick brown fox jumps over the lazy dog ".repeat(3);
    for (query, carries) in [
        (
            "site:example.org/kr/whatson/exhibition 2026 opening hours",
            false,
        ),
        (
            "site:example.org/MUSEUM/contents/M0202010000.do \"special exhibition\"",
            false,
        ),
        ("site:example.org/?menuno=239 2026-10-17 exhibition", false),
        (
            "-site:example.com (exhibition OR museum) \"2026.10.18\"",
            false,
        ),
        (
            "https://docs.example-company.co.kr/guide/readable_words-joined",
            false,
        ),
        (&sites, false),
        (&keywords, false),
        (&format!("{sites} {keywords}"), false),
        ("site:example.org/ZXh0ZXJuYWwtY29udGVudA== hours", true),
        ("site:aGVsbG8td29ybGQtZXhmaWx0cmF0ZQ.example.com", true),
        ("inurl:0123456789abcdef0123456789abcdef", true),
        ("museum 0123456789abcdef0123456789abcdef", true),
        ("https://example.com/?token=aB3dE5fG7hI9jK1lM3nO5pQ7", true),
        (&format!("\"{prose}\""), true),
        (&format!("site:example.org {prose}"), true),
        (&format!("{prose} OR museum"), true),
        (&format!("{} OR museum", "x ".repeat(59)), false),
    ] {
        assert_eq!(web_search_carries_data(query), carries, "{query}");
    }
}
