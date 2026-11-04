use super::super::page::extract_page;
use super::read_result;
use std::collections::BTreeSet;

fn query_passages_have_exact_character_spans_and_exhaust_without_repeats() {
    use std::fmt::Write;
    let mut body = String::new();
    for i in 0..40 {
        write!(body, "<p>Observation {i} records λ and 🧭. The magnitude is {i}. Context remains present.</p>").unwrap();
    }
    let page = extract_page(
        "https://example.org/",
        "https://example.org/",
        200,
        true,
        Some("text/html"),
        format!("<article>{body}</article>").as_bytes(),
        "http",
    )
    .unwrap();
    let mut seen = BTreeSet::new();
    let mut start = 0;
    loop {
        let result = read_result(&page, 1500, 2, start, Some("Observation"));
        let passages = result["passages"].as_array().unwrap();
        assert_ne!(passages.as_slice(), [] as [serde_json::Value; 0]);
        let mut size = 0;
        for passage in passages {
            let chunk = usize::try_from(passage["chunk"].as_u64().unwrap()).unwrap();
            let a = usize::try_from(passage["span"][0].as_u64().unwrap()).unwrap();
            let b = usize::try_from(passage["span"][1].as_u64().unwrap()).unwrap();
            let text = passage["text"].as_str().unwrap();
            assert_eq!(text, super::passages::slice(&page.chunks[chunk].text, a, b));
            assert!(seen.insert((chunk, a, b)));
            size += text.encode_utf16().count();
            let full = read_result(&page, 2000, 1, chunk, None);
            assert_eq!(full["markdown"], page.chunks[chunk].text);
        }
        assert!(size <= 1500);
        if result["next_start_chunk"].is_null() {
            break;
        }
        let next = usize::try_from(result["next_start_chunk"].as_u64().unwrap()).unwrap();
        assert_eq!(next, start + passages.len());
        start = next;
    }
    let all = read_result(&page, 8000, 8, 0, Some("Observation"));
    assert_eq!(all["passages"].as_array().unwrap().len(), seen.len());
    let empty = read_result(&page, 2000, 1, 0, Some("absentterm"));
    assert_eq!(empty["passages"], serde_json::json!([]));
    assert!(empty["next_start_chunk"].is_null());
}

fn table_passage_preserves_header_and_list_items_remain_units() {
    for span in ["", " rowspan='2'"] {
        let body = format!(
            "<table><tr><th>Measurement</th><th>Value</th></tr><tr><td{span}>needle</td><td>42</td></tr></table>"
        );
        let page = extract_page(
            "https://example.org/",
            "https://example.org/",
            200,
            true,
            Some("text/html"),
            body.as_bytes(),
            "http",
        )
        .unwrap();
        let result = read_result(&page, 2000, 1, 0, Some("needle"));
        let passage = &result["passages"][0];
        let text = passage["text"].as_str().unwrap();
        assert!(text.contains("Measurement"), "{text}");
        assert!(text.contains("42"), "{text}");
        let a = usize::try_from(passage["span"][0].as_u64().unwrap()).unwrap();
        let b = usize::try_from(passage["span"][1].as_u64().unwrap()).unwrap();
        assert_eq!(text, super::passages::slice(&page.chunks[0].text, a, b));
    }
    let units = super::passages::prepare("- First statement. Second statement.\n- Next item.\n");
    assert_eq!(units.len(), 2);
}

fn continued_table_rows_keep_their_header_inside_the_source_chunk() {
    use std::fmt::Write;
    for span in ["", " rowspan='1'"] {
        let mut html = String::from("<table><tr><th>Quantity</th><th>Description</th></tr>");
        for i in 0..40 {
            write!(html, "<tr><td{span}>Entry{i}</td><td>Measured quantity with complete supporting details for this observation.</td></tr>").unwrap();
        }
        html.push_str("</table>");
        let page = extract_page(
            "https://example.org/",
            "https://example.org/",
            200,
            true,
            Some("text/html"),
            html.as_bytes(),
            "http",
        )
        .unwrap();
        let result = read_result(&page, 2000, 1, 0, Some("Entry39"));
        let passage = &result["passages"][0];
        assert!(passage["chunk"].as_u64().unwrap() > 0);
        let text = passage["text"].as_str().unwrap();
        assert!(text.contains("Quantity"), "{text}");
        assert!(text.contains("Entry39"), "{text}");
        let chunk = usize::try_from(passage["chunk"].as_u64().unwrap()).unwrap();
        let a = usize::try_from(passage["span"][0].as_u64().unwrap()).unwrap();
        let b = usize::try_from(passage["span"][1].as_u64().unwrap()).unwrap();
        assert_eq!(text, super::passages::slice(&page.chunks[chunk].text, a, b));
    }
}

// Extend the existing evidence projection contract with passage/span cases.
pub(in crate::web_access) fn verify_passage_cases() {
    for case in [
        query_passages_have_exact_character_spans_and_exhaust_without_repeats,
        table_passage_preserves_header_and_list_items_remain_units,
        continued_table_rows_keep_their_header_inside_the_source_chunk,
    ] {
        case();
    }
}
