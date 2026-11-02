//! Compare evidence as text as well as its Markdown/HTML transport spelling.
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use std::sync::LazyLock;

pub(super) fn visible(markdown: &str) -> String {
    let mut text = String::new();
    let mut code_block = false;
    for event in Parser::new_ext(
        markdown,
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH,
    ) {
        match event {
            Event::Start(Tag::CodeBlock(_)) => code_block = true,
            Event::End(TagEnd::CodeBlock) => {
                code_block = false;
                text.push(' ');
            }
            Event::Text(value) if code_block => text.push_str(&html_text(&value)),
            Event::Text(value) => text.push_str(&value),
            Event::Code(value) | Event::Html(value) | Event::InlineHtml(value) => {
                text.push_str(&html_text(&value));
            }
            Event::End(
                TagEnd::Emphasis
                | TagEnd::Strong
                | TagEnd::Strikethrough
                | TagEnd::Link
                | TagEnd::Image,
            ) => {}
            Event::End(_) | Event::SoftBreak | Event::HardBreak | Event::Rule => text.push(' '),
            _ => {}
        }
    }
    text
}

fn html_text(fragment: &str) -> String {
    // Native page windows can start inside a table. Keep cell boundaries even
    // when HTML parsing repairs the fragment outside its original table context.
    static BLOCK: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
        r"(?i)</?(?:address|article|aside|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|th|thead|tr|ul)\b"
    ).unwrap()
    });
    let spaced = BLOCK.replace_all(fragment, " $0");
    let document = dom_query::Document::from(spaced.as_ref());
    document
        .select("script, style, noscript, template")
        .remove();
    let text = document.select("body").formatted_text();
    if BLOCK.is_match(fragment) {
        format!(" {text} ")
    } else {
        text.to_string()
    }
}

// test-category: pure-logic
#[test]
fn transport_markup_preserves_evidence_text_and_numbers()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let normal = super::policy::normalized;
    for (input, expected) in [
        (
            "A [binary](https://example.org/docs) `file` object.",
            "A binary file object.",
        ),
        (
            "    <tr><td>North &amp; South</td><td>7</td><td>11</td></tr>",
            "North & South 7 11",
        ),
        ("관람료 **- 무료**", "관람료 - 무료"),
        (
            "The **value** is `1.5`, not 15.",
            "The value is 1.5, not 15.",
        ),
    ] {
        assert_eq!(normal(&visible(input)), normal(expected));
    }
    Ok(())
}
