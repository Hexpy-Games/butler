use std::sync::Arc;

use bytes::Bytes;
use serde_json::{Value, json};

use super::*;
use crate::{
    locale::LocaleCollation,
    models::{ModelCatalogSnapshotInput, ProviderConfigFuture, ProviderConfigRequest},
};

struct SnapshotPort(Arc<ModelCatalogSnapshot>);

impl ProviderRequestConfigPort for SnapshotPort {
    fn effective_prompt_model(&self, _: Option<&str>) -> Result<String, ModelRoundError> {
        unreachable!()
    }

    fn resolve<'a>(&'a self, _: ProviderConfigRequest<'a>) -> ProviderConfigFuture<'a> {
        unreachable!()
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
    let serialized = Bytes::from(crate::json::stringify(body).unwrap());
    PreparedRequestAdmission::new(PrepareAdmissionInput {
        catalog,
        config,
        provider: "openai",
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

#[test]
fn matches_bun_hash_plan_and_codex_capacity_alias() {
    let (catalog, config) = source();
    let basic = json!({"model":"gpt-5.5","store":true,"input":"hello"});
    let admitted = prepare(&catalog, &config, "openai/gpt-5.5", &basic, 64.0)
        .admit()
        .unwrap();
    assert_eq!(
        admitted.request_hash,
        "236cb4bf6adb2ae4ecb963846372219a3a6085f9884f13c11bb0741cf5fc4d42"
    );
    assert_eq!(admitted.plan.compiled_input_tokens, 18.0);
    assert_eq!(admitted.plan.input_capacity_tokens, 1_049_936.0);
    assert_eq!(admitted.plan.turn_id, "unattributed");

    let codex = json!({"model":"gpt-5.5","input":"hello"});
    let admitted = prepare(&catalog, &config, "openai/gpt-5.5-codex", &codex, 64.0)
        .admit()
        .unwrap();
    assert_eq!(admitted.plan.model_ref, "openai/gpt-5.5-codex");
    assert_eq!(admitted.plan.context_window_tokens, 1_050_000.0);
    assert_eq!(admitted.plan.compiled_input_tokens, 14.0);
}

#[test]
fn image_projection_and_output_failure_match_bun() {
    let (catalog, config) = source();
    let image = json!({"model":"gpt-5.5","input":[{"type":"input_image","image_url":"data:image/png;base64,AAAA"}]});
    let admitted = prepare(&catalog, &config, "openai/gpt-5.5", &image, 64.0)
        .admit()
        .unwrap();
    assert_eq!(
        admitted.request_hash,
        "e04d272685f582d019307bdf75a27adb3bc97a8d05eff86a813ce406626fca14"
    );
    assert_eq!(admitted.plan.compiled_input_tokens, 8_222.0);

    let overflow = json!({"input":"x"});
    let error = match prepare(&catalog, &config, "openai/gpt-5.5", &overflow, 1_050_000.0).admit() {
        Ok(_) => panic!("overflow request was admitted"),
        Err(error) => error,
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
}
