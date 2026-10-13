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
}
