use std::sync::Arc;

use bytes::Bytes;
use serde_json::{Value, json};

use super::*;
use crate::models::{ModelCatalogSnapshotInput, ProviderConfigFuture, ProviderConfigRequest};
use butler_core::locale::LocaleCollation;

struct SnapshotPort(Arc<ModelCatalogSnapshot>);

impl ProviderRequestConfigPort for SnapshotPort {
    fn effective_prompt_model(&self, _: Option<&str>) -> Result<String, ModelRoundError> {
        panic!("not used by this test")
    }

    fn resolve<'a>(&'a self, _: ProviderConfigRequest<'a>) -> ProviderConfigFuture<'a> {
        panic!("not used by this test")
    }

    fn sizing_snapshot(
        &self,
        _: Option<&str>,
    ) -> Result<Arc<ModelCatalogSnapshot>, ModelRoundError> {
        Ok(Arc::clone(&self.0))
    }
}

fn source() -> (ModelCatalog, SnapshotPort) {
    let catalog = ModelCatalog::new().unwrap();
    let snapshot = catalog
        .snapshot(
            ModelCatalogSnapshotInput {
                configured_local: Vec::new(),
                extra_models: Vec::new(),
                registered_models: Vec::new(),
                credential_views: Vec::new(),
                default_model_ref: None,
                generated_at: "now".into(),
            },
            &LocaleCollation::new("en-US").unwrap(),
        )
        .unwrap();
    (catalog, SnapshotPort(Arc::new(snapshot)))
}

fn prepare<'a>(
    catalog: &'a ModelCatalog,
    config: &'a SnapshotPort,
    model_ref: &'a str,
    body: &'a Value,
    output: f64,
) -> PreparedRequestAdmission<'a> {
    let serialized = Bytes::from(butler_core::json::stringify(body).unwrap());
    PreparedRequestAdmission::new(&PrepareAdmissionInput {
        catalog,
        config,
        provider: model_ref.split_once('/').unwrap().0,
        model_ref,
        butler_data: None,
        requested_output_tokens: Some(output),
        context_window_tokens: None,
        max_output_tokens: None,
        body,
        serialized,
    })
    .unwrap()
}

// test-category: pure-logic
#[test]
fn exact_token_counts_image_projection_and_output_overflow() {
    crate::models::tokenizer::verification::exact_encoding();
    let (catalog, config) = source();
    let image = json!({"model":"gpt-5.5","input":[{"type":"input_image","image_url":"data:image/png;base64,AAAA"}]});
    let admitted = prepare(&catalog, &config, "openai/gpt-5.5", &image, 64.0)
        .admit()
        .unwrap();
    assert_eq!(admitted.plan.compiled_input_tokens, 8_222.0);

    let overflow = json!({"input":"x"});
    let Err(error) = prepare(&catalog, &config, "openai/gpt-5.5", &overflow, 1_050_000.0).admit()
    else {
        panic!("overflow request was admitted")
    };
    assert!(matches!(
        error,
        ModelRoundError::RequestAdmission(error)
            if error.code == ModelRequestAdmissionCode::OutputCapacityExceeded
                && error.plan.as_ref().is_some_and(|plan|
                    plan.admission == RequestContextAdmission::CannotFitRequired
                    && plan.compiled_input_tokens == 5.0
                    && plan.input_capacity_tokens == 0.0)
    ));
    every_carrier_image_shape_is_projected_and_other_text_is_not();
}

/// Inline images on every carrier cost the image allowance wherever the
/// carrier places them (user content, tool results, Gemini parts); base64
/// outside an image position remains text.
fn every_carrier_image_shape_is_projected_and_other_text_is_not() {
    let (catalog, config) = source();
    // 4 MB of base64: about 1.05M estimated tokens if counted as text.
    let data = "QUJD".repeat(1_000_000);
    let anthropic = json!({"model":"claude-opus-5-5","messages":[
        {"role":"user","content":[
            {"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":data}},
            {"type":"text","text":"What is this?"}]},
        {"role":"assistant","content":[{"type":"tool_use","id":"t","name":"x",
            "input":{"type":"base64","media_type":"image/png","data":"QUJD"}}]},
        {"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":[
            {"type":"text","text":"observed"},
            {"type":"image","source":{"type":"base64","media_type":"IMAGE/PNG","data":data}}]}]}]});
    let gemini = json!({"contents":[
        {"role":"user","parts":[{"inline_data":{"mime_type":"image/png","data":data}},{"text":"hi"}]},
        {"role":"user","parts":[{"functionResponse":{"name":"x","response":{}}},
            {"inlineData":{"mimeType":"image/jpeg","data":data}}]}]});
    for (model, body) in [
        ("anthropic/claude-opus-5-5", &anthropic),
        ("google/gemini-3.8-flash", &gemini),
    ] {
        let (text, count) = image_token_projection(body).unwrap();
        assert_eq!(count, 2, "{model}");
        assert!(!text.contains(&data), "{model}");
        let placeholder = format!("[image input bytes={}]", data.len());
        assert_eq!(text.matches(&placeholder).count(), 2, "{model}");
        let estimated = catalog
            .estimate_tokens(&config.0, TokenEstimateInput::Text(&text), Some(model))
            .unwrap()
            .tokens;
        let admitted = prepare(&catalog, &config, model, body, 64.0)
            .admit()
            .unwrap();
        assert_eq!(
            admitted.plan.compiled_input_tokens,
            estimated + 2.0 * IMAGE_TOKEN_ALLOWANCE,
            "{model}"
        );
    }
    // A tool input that merely resembles a source block is model text.
    assert!(
        image_token_projection(&anthropic)
            .unwrap()
            .0
            .contains(r#""data":"QUJD""#)
    );
    let text = json!({"messages":[{"role":"user","content":[{"type":"text","text":data},
        {"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"QUJD"}}]}]});
    assert_eq!(image_token_projection(&text).unwrap().1, 0);
    let Err(error) = prepare(&catalog, &config, "anthropic/claude-opus-5-5", &text, 64.0)
        .admit()
        .map(|_| ())
    else {
        panic!("4 MB of text was admitted as an image")
    };
    assert!(matches!(
        error,
        ModelRoundError::RequestAdmission(error)
            if error.code == ModelRequestAdmissionCode::ContextCapacityExceeded
    ));
}
