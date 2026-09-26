use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::super::support::{Root, service_with_parts};
use super::super::*;
use crate::models::{
    ProviderPromptFuture, ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest,
    ProviderPromptResult,
};

struct ImportProvider;
impl ProviderPromptPort for ImportProvider {
    fn run_prompt<'a>(
        &'a self,
        _request: ProviderPromptRequest<'a>,
        _lifecycle: ProviderPromptLifecycle<'a>,
    ) -> ProviderPromptFuture<'a> {
        Box::pin(async {
            Ok(ProviderPromptResult {
                text: r#"prefix {"candidates":[
                    {"category":"communication","summary":"Use concise answers","source_type":"explicit","confidence":"high"},
                    {"category":"communication","summary":"   "},
                    {"category":"identity","summary":"Private identity"},
                    "invalid"
                ]} suffix"#
                    .into(),
                model: "openai/test".into(),
                usage: None,
            })
        })
    }
}

#[tokio::test]
async fn forgiving_import_writes_private_manifest_before_consolidation() {
    let root = Root::new("third-party-import");
    let (service, _) = service_with_parts(
        &root,
        Arc::new(Mutex::new(HashMap::new())),
        Arc::new(ImportProvider),
    );
    service
        .set_profiling_mode(ProfilingMode::Basic)
        .await
        .unwrap();
    let result = service
        .import_profile_candidates_from_third_party_dump_with_model(
            ProfileThirdPartyImportOptions {
                text: "  durable preference\r\nfrom export  ".into(),
                source: Some(" Other Assistant! ".into()),
                model: None,
                now_epoch_millis: Some(1_700_000_000_000.0),
                cancellation: Default::default(),
            },
        )
        .await
        .unwrap();
    assert_eq!(result.imported_candidate_count, 1);
    assert!(result.model_called);
    assert_eq!(result.source, "other-assistant");
    let import_id = result.import_id.unwrap();
    let digest = import_id.rsplit(':').next().unwrap();
    let path = root
        .0
        .join("personalization/profile-imports")
        .join(format!("{digest}.json"));
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(manifest["import_id"], import_id);
    assert_eq!(manifest["imported_at"], "2023-11-14T22:13:20.000Z");
    assert_eq!(manifest["raw_text_included"], false);
    assert!(manifest.get("text").is_none());
    assert_eq!(manifest["candidate_ids"].as_array().unwrap().len(), 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    service.close().await;
}

#[tokio::test]
async fn invalid_date_override_fails_only_after_nonempty_import_admission() {
    let root = Root::new("third-party-import-date");
    let (service, _) = service_with_parts(
        &root,
        Arc::new(Mutex::new(HashMap::new())),
        Arc::new(ImportProvider),
    );
    service
        .set_profiling_mode(ProfilingMode::Basic)
        .await
        .unwrap();
    let options = |text: &str| ProfileThirdPartyImportOptions {
        text: text.into(),
        source: None,
        model: None,
        now_epoch_millis: Some(f64::NAN),
        cancellation: Default::default(),
    };
    let empty = service
        .import_profile_candidates_from_third_party_dump_with_model(options("  "))
        .await
        .unwrap();
    assert!(!empty.model_called);
    let error = service
        .import_profile_candidates_from_third_party_dump_with_model(options("content"))
        .await
        .unwrap_err();
    assert_eq!(error.code, "profile_data_invalid");
    service.close().await;
}
