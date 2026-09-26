use crate::models::{
    ProviderPromptFuture, ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest,
    ProviderPromptResult,
};

pub(super) struct Provider;

impl ProviderPromptPort for Provider {
    fn run_prompt<'a>(
        &'a self,
        request: ProviderPromptRequest<'a>,
        _lifecycle: ProviderPromptLifecycle<'a>,
    ) -> ProviderPromptFuture<'a> {
        let prompt = request.prompt.to_owned();
        Box::pin(async move {
            let input: serde_json::Value = serde_json::from_str(&prompt).unwrap();
            let reference = input["observations"]
                .as_array()
                .and_then(|values| values.first())
                .and_then(|value| value["ref"].as_str());
            Ok(ProviderPromptResult {
                text: reference.map_or_else(
                    || r#"{"candidates":[]}"#.into(),
                    |reference| {
                        serde_json::json!({"candidates":[{
                            "category":"communication","summary":"Prefers concise answers",
                            "source_type":"explicit","confidence":"high",
                            "evidence_refs":[reference],"sensitive_domain":false
                        }]})
                        .to_string()
                    },
                ),
                model: "openai/test".into(),
                usage: None,
            })
        })
    }
}
