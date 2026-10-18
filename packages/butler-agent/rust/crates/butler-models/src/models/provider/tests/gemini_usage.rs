//! Format pin: generated output includes the reasoning subset.
use super::*;
pub(super) fn output_includes_thoughts() {
    let messages = [];
    let request = request(
        "google/gemini-3.8-flash",
        &messages,
        &ReasoningEffort::Medium,
        CancellationToken::new(),
        None,
    );
    for thoughts in [Some(147), None] {
        let mut response = serde_json::json!({"candidates":[{"content":{"parts":[{"text":"done"}]}}],
            "usageMetadata":{"promptTokenCount":137_871,"candidatesTokenCount":3951,"totalTokenCount":142_000,"toolUsePromptTokenCount":31}});
        if let Some(thoughts) = thoughts {
            response["usageMetadata"]["thoughtsTokenCount"] = thoughts.into();
        }
        let decoded = result::decode(
            response,
            "google",
            "google/gemini-3.8-flash",
            serialize::Carrier::Gemini,
            0,
            &request,
            None,
        );
        let usage = decoded.usage.unwrap();
        assert_eq!(usage["promptTokens"], 137_871.0);
        assert_eq!(
            usage["outputTokens"],
            f64::from(3951 + thoughts.unwrap_or(0))
        );
        if let Some(thoughts) = thoughts {
            assert_eq!(usage["reasoningTokens"], f64::from(thoughts));
        } else {
            assert!(usage.get("reasoningTokens").is_none());
        }
    }
}
