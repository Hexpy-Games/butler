use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;

pub(super) fn sizing_counts_image_allowance_and_preserves_complete_wire_bytes() {
    let (catalog, snapshot) = catalog();
    let pixels = STANDARD.encode(
        [0xff, 0xd8]
            .into_iter()
            .chain(vec![0x42; 100_000])
            .collect::<Vec<_>>(),
    );
    let content = json!({"output":{"schema":"butler.browser-observation.v1","status":"ok",
        "obs":"o1","untrusted_content":{"text":"complete latest state"},
        "image":{"mime_type":"image/jpeg","data":pixels}}})
    .to_string();
    let message: ModelRoundMessage = serde_json::from_value(
        json!({"role":"tool", "name":"browser_observe", "toolCallId":"call", "content":content}),
    )
    .unwrap();
    let items = serde_json::Value::Array(serialize::bounded_items(std::slice::from_ref(&message)));
    let wire = butler_core::json::stringify(&items).unwrap();
    let (text, count) = crate::models::request_admission::image_token_projection(&items).unwrap();
    assert_eq!(count, 1);
    assert!(text.contains("complete latest state"));
    assert!(!text.contains(&pixels));
    let expected = catalog
        .estimate_tokens(
            &snapshot,
            crate::models::TokenEstimateInput::Text(&text),
            Some("openai/gpt-6-luna"),
        )
        .unwrap()
        .tokens
        + 8192.0;
    let cache = super::super::sizing::Cache::default();
    let measured = super::super::sizing::measure(
        &catalog,
        &snapshot,
        "openai/gpt-6-luna",
        std::slice::from_ref(&message),
        &cache,
    )
    .unwrap();
    assert_eq!(measured.pressure_bytes, expected * 2.0);
    assert_eq!(measured.stateless_bytes, Some(wire.len()));
    assert!(wire.contains(&pixels));
    let plain = ModelRoundMessage::user("complete plain text".into(), None);
    let items = serde_json::Value::Array(serialize::bounded_items(std::slice::from_ref(&plain)));
    let wire = butler_core::json::stringify(&items).unwrap();
    let expected = catalog
        .estimate_tokens(
            &snapshot,
            crate::models::TokenEstimateInput::Text(&wire),
            Some("openai/gpt-6-luna"),
        )
        .unwrap()
        .tokens;
    let measured =
        super::super::sizing::measure(&catalog, &snapshot, "openai/gpt-6-luna", &[plain], &cache)
            .unwrap();
    assert_eq!(measured.pressure_bytes, expected * 2.0);
    assert_eq!(measured.stateless_bytes, Some(wire.len()));
}

pub(super) fn long_history_sizing_matches_full_projection() {
    let (catalog, snapshot) = catalog();
    let cache = super::super::sizing::Cache::default();
    let mut projection_cache = super::super::prefix_diagnostics::components::Cache::default();
    let mut messages = long_history();
    for round in ["cold", "unchanged", "append", "replace", "truncate"] {
        match round {
            "append" => messages.push(ModelRoundMessage::user(
                "latest appended state".into(),
                None,
            )),
            "replace" => {
                messages[0] = ModelRoundMessage::user("replaced image with text".into(), None);
            }
            "truncate" => messages.truncate(100),
            _ => {}
        }
        let items = serde_json::Value::Array(serialize::bounded_items(&messages));
        let wire = butler_core::json::stringify(&items).unwrap();
        let (text, images) =
            crate::models::request_admission::image_token_projection(&items).unwrap();
        assert_eq!(items.as_array().unwrap().len(), messages.len());
        assert_eq!(
            images,
            if round == "truncate" {
                19
            } else if round == "replace" {
                199
            } else {
                200
            }
        );
        let expected = catalog
            .estimate_tokens(
                &snapshot,
                crate::models::TokenEstimateInput::Text(&text),
                Some("openai/gpt-6-luna"),
            )
            .unwrap()
            .tokens
            + f64::from(images) * crate::models::request_admission::IMAGE_TOKEN_ALLOWANCE;
        let started = std::time::Instant::now();
        let measured = super::super::sizing::measure(
            &catalog,
            &snapshot,
            "openai/gpt-6-luna",
            &messages,
            &cache,
        )
        .unwrap();
        let elapsed = started.elapsed();
        assert_eq!(measured.pressure_bytes, expected * 2.0);
        assert_eq!(measured.stateless_bytes, Some(wire.len()));
        let (cached_wire, cached_text, cached_images) = projection_cache
            .array_sizing(items.as_array().unwrap())
            .unwrap();
        assert_eq!(cached_wire, wire);
        assert_eq!(cached_text, text);
        assert_eq!(cached_images, images);
        eprintln!(
            "sizing round={round} messages={} images={images} wire_bytes={} pressure_bytes={} measure_ms={:.3}",
            messages.len(),
            wire.len(),
            measured.pressure_bytes,
            elapsed.as_secs_f64() * 1000.0
        );
    }
}

fn long_history() -> Vec<ModelRoundMessage> {
    let pixels = STANDARD.encode(
        [0xff, 0xd8]
            .into_iter()
            .chain(vec![0x42; 32_000])
            .collect::<Vec<_>>(),
    );
    (0..1000).map(|index| {
        if index % 5 != 0 {
            return ModelRoundMessage::user(format!("message {index}: {}", "complete observed state ".repeat(40)), None);
        }
        serde_json::from_value(json!({"role":"tool", "name":"browser_observe",
            "toolCallId":format!("call-{index}"),
            "content":json!({"output":{"schema":"butler.browser-observation.v1", "status":"ok",
                "obs":format!("o{index}"), "untrusted_content":{"text":format!("complete state {index}")},
                "image":{"mime_type":"image/jpeg", "data":pixels}}}).to_string()
        })).unwrap()
    }).collect()
}
