use super::extract_readable_html;
use std::collections::BTreeSet;

fn main_then_other_then_chrome_keeps_all_text_tokens() {
    let html = "<body><header>banner</header><div>introduction</div><main><h1>Result</h1><p>measurement forty two</p></main><section>appendix</section><nav><a>navigation</a></nav><aside>sidebar</aside><footer>footer</footer></body>";
    let result = extract_readable_html(html, "https://example.org/");
    let text = &result.markdown;
    let chrome = text.find("## Page chrome").unwrap();
    assert!(
        text.find("measurement").unwrap() < text.find("introduction").unwrap(),
        "{text}"
    );
    assert!(text.find("appendix").unwrap() < chrome);
    for word in ["banner", "navigation", "sidebar", "footer"] {
        assert!(text.find(word).unwrap() > chrome, "{text}");
    }
    let before: BTreeSet<_> = [
        "banner",
        "introduction",
        "Result",
        "measurement",
        "forty",
        "two",
        "appendix",
        "navigation",
        "sidebar",
        "footer",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    let after: BTreeSet<_> = text
        .replace("## Page chrome (navigation, ads, repeated blocks)", "")
        .split_whitespace()
        .map(str::to_owned)
        .filter(|s| s != "#")
        .collect();
    assert_eq!(before, after);
}

fn structural_roles_hidden_and_link_density_move_after_evidence() {
    let chrome = [
        "<div role='search'>roletext</div>",
        "<div hidden>hiddentext</div>",
        "<div aria-hidden='true'>ariatext</div>",
        "<div style='DISPLAY: none !important'>styletext</div>",
        "<form><button>controltext</button></form>",
        "<dialog>dialogtext</dialog>",
        "<div><a>A</a> <a>B</a> <a>C</a></div>",
        "<template>templatetext</template>",
    ];
    for fragment in chrome {
        let html = format!(
            "{fragment}<main><p>The recorded evidence is complete and readable.</p></main>"
        );
        let result = extract_readable_html(&html, "https://example.org/");
        let text = &result.markdown;
        let boundary = text
            .find("## Page chrome")
            .unwrap_or_else(|| panic!("{fragment}: {text}"));
        assert!(text.find("recorded evidence").unwrap() < boundary, "{text}");
    }
}

fn repeats_collapse_at_first_occurrence_and_raw_text_never_leaks() {
    let html = "<nav><p>repeat block</p></nav><main><p>repeat   block</p><p>Evidence retained</p><style>.secret { color: red }</style><!-- comment-secret --><script>if (a < b) secret()</script></main><style>unterminated-secret";
    let text = extract_readable_html(html, "https://example.org/").markdown;
    assert_eq!(text.matches("repeat block").count(), 1, "{text}");
    assert!(text.find("repeat block").unwrap() > text.find("## Page chrome").unwrap());
    assert!(!text.contains("secret"), "{text}");
    assert!(text.contains("Evidence retained"));
}

fn simple_and_complex_tables_strip_every_nonstructural_attribute() {
    let simple = "<table class='css'><caption>Recorded measurements</caption><tr><th title='tip'>Name</th><th>Value</th></tr><tr onclick='bad'><td><a href='/target' data-x='bad'>Item</a></td><td style='bad'>42<style>secret</style><script>secret()</script></td></tr></table>";
    let text = extract_readable_html(simple, "https://example.org/").markdown;
    assert!(
        text.contains("| Name | Value |\n| --- | --- |\n| Item | 42 |"),
        "{text}"
    );
    assert!(!text.contains("secret"));
    assert!(text.contains("Recorded measurements"));
    let complex = simple.replace(
        "<td style='bad'>",
        "<td rowspan='2' scope='row' headers='value' style='bad'>",
    );
    let text = extract_readable_html(&complex, "https://example.org/").markdown;
    assert!(
        text.contains("<td rowspan=\"2\" scope=\"row\" headers=\"value\">42</td>"),
        "{text}"
    );
    for residue in [
        "class=", "title=", "onclick=", "href=", "data-", "style=", "secret",
    ] {
        assert!(!text.contains(residue), "{text}");
    }
}

fn iframe_raw_text_is_sanitized_before_becoming_chrome() {
    let html = "<body><iframe><p>Frame fallback evidence</p><style>.secret{color:red}</style><script>secret()</script><!-- secret --></iframe><main>Readable main evidence</main></body>";
    let text = extract_readable_html(html, "https://example.org/").markdown;
    assert!(text.contains("Frame fallback evidence"), "{text}");
    assert!(text.starts_with("Readable main evidence"), "{text}");
    assert!(!text.contains("secret"), "{text}");
}

fn comparisons_and_quotes_in_raw_text_do_not_consume_structural_closes() {
    let html = "<html><head><title>Structure title</title><script>for (let n = 0; n < limit; n++) { // don't parse this as markup\n value = 1; }</script><style>.secret { color: red }</style></head><body><main>Generic evidence survives.</main></body></html>";
    let text = extract_readable_html(html, "https://example.org/").markdown;
    assert!(text.starts_with("Generic evidence survives."), "{text}");
    for residue in ["secret", "let n", "value =", "<script", "<style"] {
        assert!(!text.contains(residue), "{text}");
    }
    assert_eq!(
        super::title_from_html(html).as_deref(),
        Some("Structure title")
    );
}

fn nested_tables_keep_cell_text_and_strip_attributes_at_every_depth() {
    let html = "<table class='outer'><tr><td>Outer<table data-x='inner'><tr><th title='tip'>Inner</th></tr><tr><td onclick='bad'><p>First</p><p>Second</p><style>secret</style></td></tr></table></td></tr></table>";
    let text = extract_readable_html(html, "https://example.org/").markdown;
    assert_eq!(text.matches("<table>").count(), 2, "{text}");
    for content in ["Outer", "Inner", "First", "Second"] {
        assert!(text.contains(content), "{text}");
    }
    for residue in ["class=", "data-", "title=", "onclick=", "secret"] {
        assert!(!text.contains(residue), "{text}");
    }
}

// Extend the existing HTML parsing contract with a table of extraction cases.
pub(super) fn verify_extraction_cases() {
    for case in [
        main_then_other_then_chrome_keeps_all_text_tokens,
        structural_roles_hidden_and_link_density_move_after_evidence,
        repeats_collapse_at_first_occurrence_and_raw_text_never_leaks,
        simple_and_complex_tables_strip_every_nonstructural_attribute,
        iframe_raw_text_is_sanitized_before_becoming_chrome,
        comparisons_and_quotes_in_raw_text_do_not_consume_structural_closes,
        nested_tables_keep_cell_text_and_strip_attributes_at_every_depth,
    ] {
        case();
    }
}
