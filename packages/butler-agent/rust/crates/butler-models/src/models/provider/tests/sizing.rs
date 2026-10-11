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
