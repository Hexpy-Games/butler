use serde_json::{Value, json};

use super::*;
use crate::segmentation::split_grapheme_utf8_spans;

#[test]
fn compiled_policies_match_actual_bun_for_numeric_boundaries() {
    let fixture: Value =
        serde_json::from_str(include_str!("tests/fixtures/bun-policy.json")).unwrap();
    for row in fixture["policy"].as_array().unwrap() {
        let max_bytes = number(&row["max"]);
        assert_eq!(model_json("abcdef", max_bytes), row["model"]);
        assert_eq!(
            span_json(split_historical_source_spans("abcdef", max_bytes)),
            row["historical"]
        );
        assert_eq!(
            span_json(split_meaning_source_spans(
                "One short. Second sentence.",
                max_bytes
            )),
            row["meaning"]
        );
    }
    assert_eq!(model_json("👩🏽‍🚀", 1.0), fixture["oversized"]["model"]);
    assert_eq!(
        span_json(split_historical_source_spans("👩🏽‍🚀", 1.0)),
        fixture["oversized"]["historical"]
    );
    assert_eq!(
        span_json(split_meaning_source_spans("👩🏽‍🚀", 1.0)),
        fixture["oversized"]["meaning"]
    );
    assert_eq!(
        span_json(split_meaning_source_spans(
            "One short. Second sentence.",
            15.0
        )),
        fixture["sentencePreferred"]
    );
}

#[test]
fn midpoint_and_distinct_historical_rows_preserve_source_order() {
    assert_eq!(
        split_grapheme_utf8_spans("abcdef", 4.0)
            .into_iter()
            .map(|span| (span.start, span.end, span.oversized))
            .collect::<Vec<_>>(),
        vec![(0, 4, false), (4, 6, false)]
    );
    assert_eq!(
        split_historical_source_spans("abcdef", 4.0),
        vec![
            ByteSpan { start: 0, end: 4 },
            ByteSpan { start: 4, end: 5 },
            ByteSpan { start: 5, end: 6 },
        ]
    );
    let a = "a".repeat(600);
    let b = "b".repeat(600);
    assert_eq!(
        nearest_grapheme_byte_midpoint(&[
            WindowPart {
                text: &a,
                bytes: 600.0
            },
            WindowPart {
                text: &b,
                bytes: 600.0
            },
        ]),
        Some(ByteMidpoint {
            part_index: 0,
            local_byte: 600
        })
    );
    for bytes in [f64::NAN, -600.0, f64::INFINITY] {
        assert_eq!(
            nearest_grapheme_byte_midpoint(&[
                WindowPart { text: &a, bytes },
                WindowPart {
                    text: &b,
                    bytes: 600.0
                },
            ]),
            None
        );
    }
}

#[test]
fn source_default_and_runtime_null_remain_distinct_at_typed_boundary() {
    let fixture: Value =
        serde_json::from_str(include_str!("tests/fixtures/bun-null-default.json")).unwrap();
    assert_eq!(
        model_json("abcdef", MEMORY_SOURCE_WINDOW_BYTES),
        fixture["modelOmitted"]
    );
    assert_eq!(model_json("abcdef", 0.0), fixture["modelNull"]);
    assert_eq!(
        span_json(split_historical_source_spans("abcdef", 0.0)),
        fixture["historicalNull"]
    );
    assert_eq!(
        span_json(split_meaning_source_spans("abc.", 0.0)),
        fixture["meaningNull"]
    );
    assert_eq!(grapheme_byte_boundaries(""), vec![0]);
    assert_eq!(
        split_meaning_source_spans(&"a".repeat(513), f64::INFINITY),
        vec![
            ByteSpan { start: 0, end: 512 },
            ByteSpan {
                start: 512,
                end: 513
            },
        ]
    );
}

#[test]
fn meaning_byte_cap_distinguishes_infinity_from_nan_before_grapheme_cap() {
    let fixture: Value =
        serde_json::from_str(include_str!("tests/fixtures/bun-policy.json")).unwrap();
    let cluster = "a\u{300}\u{301}\u{302}";
    let text = cluster.repeat(500);
    assert_eq!(text.len(), 3_500);

    assert_eq!(
        split_meaning_source_spans(&text, f64::INFINITY),
        vec![ByteSpan {
            start: 0,
            end: 3_500
        }]
    );

    let text = format!("{text}{cluster}");
    assert_eq!(
        span_json(split_meaning_source_spans(&text, f64::INFINITY)),
        fixture["meaningCap"]["infinity"]
    );
    assert_eq!(
        span_json(split_meaning_source_spans(&text, f64::NAN)),
        fixture["meaningCap"]["nan"]
    );
}

fn number(value: &Value) -> f64 {
    if let Some(value) = value.as_f64() {
        return value;
    }
    match value.as_str().unwrap() {
        "NaN" => f64::NAN,
        "Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        value => panic!("unexpected numeric fixture {value}"),
    }
}

fn model_json(text: &str, max_bytes: f64) -> Value {
    Value::Array(
        split_grapheme_utf8_spans(text, max_bytes)
            .into_iter()
            .map(|span| json!({"start":span.start,"end":span.end,"oversized":span.oversized}))
            .collect(),
    )
}

fn span_json(spans: Vec<ByteSpan>) -> Value {
    Value::Array(
        spans
            .into_iter()
            .map(|span| json!({"start":span.start,"end":span.end}))
            .collect(),
    )
}
