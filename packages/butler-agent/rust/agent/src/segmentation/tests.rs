use serde_json::Value;

use super::*;

#[test]
fn actual_bun_multilingual_boundaries_match_unicode17_candidate() {
    assert_eq!(unicode_segmentation::UNICODE_VERSION, (17, 0, 0));
    let fixture: Value =
        serde_json::from_str(include_str!("tests/fixtures/bun-boundaries.json")).unwrap();
    for row in fixture["rows"].as_array().unwrap() {
        let text = row["text"].as_str().unwrap();
        let graphemes = grapheme_segments(text).collect::<Vec<_>>();
        assert_eq!(
            graphemes
                .iter()
                .map(|segment| segment.text)
                .collect::<Vec<_>>(),
            strings(&row["graphemes"]),
            "graphemes for {}",
            row["id"]
        );
        let mut boundaries = vec![0];
        boundaries.extend(graphemes.iter().map(|segment| segment.end));
        assert_eq!(boundaries, numbers(&row["graphemeBytes"]));

        let sentences = sentence_segments(text).collect::<Vec<_>>();
        let expected = row["sentences"].as_array().unwrap();
        assert_eq!(sentences.len(), expected.len());
        for (actual, expected) in sentences.iter().zip(expected) {
            assert_eq!(actual.text, expected["segment"]);
            assert_eq!(
                actual.start,
                expected["byteStart"].as_u64().unwrap() as usize
            );
            assert_eq!(actual.end, expected["byteEnd"].as_u64().unwrap() as usize);
            assert_eq!(
                &text.as_bytes()[actual.start..actual.end],
                actual.text.as_bytes()
            );
        }
    }
}

#[test]
fn actual_bun_matches_all_embedded_unicode17_uax_cases() {
    let fixture: Value =
        serde_json::from_str(include_str!("tests/fixtures/uax17-cases.json")).unwrap();
    let mut grapheme_count = 0;
    for row in fixture["grapheme"].as_array().unwrap() {
        grapheme_count += 1;
        assert_eq!(
            grapheme_segments(row["text"].as_str().unwrap())
                .map(|segment| segment.text)
                .collect::<Vec<_>>(),
            strings(&row["expected"])
        );
    }
    let mut sentence_count = 0;
    for row in fixture["sentence"].as_array().unwrap() {
        sentence_count += 1;
        assert_eq!(
            sentence_segments(row["text"].as_str().unwrap())
                .map(|segment| segment.text)
                .collect::<Vec<_>>(),
            strings(&row["expected"])
        );
    }
    assert_eq!((grapheme_count, sentence_count), (766, 512));
    let bun: Value =
        serde_json::from_str(include_str!("tests/fixtures/uax17-bun-summary.json")).unwrap();
    assert_eq!(bun["grapheme"]["failures"], 0);
    assert_eq!(bun["sentence"]["failures"], 0);
}

fn strings(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect()
}

fn numbers(value: &Value) -> Vec<usize> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_u64().unwrap() as usize)
        .collect()
}
