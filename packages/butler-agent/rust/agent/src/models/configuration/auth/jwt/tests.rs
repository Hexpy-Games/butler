use base64::Engine as _;
use serde_json::json;

use super::*;

fn token(payload: Value) -> String {
    let body = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&payload).unwrap());
    format!("head.{body}.signature")
}

#[test]
fn access_token_claims_follow_account_precedence_for_either_base64_alphabet() {
    // account precedence and codex authorization excludes sub fallback
    {
        let access = token(json!({
            "sub":"subject",
            "https://api.openai.com/auth": {
                "account_id":"legacy", "chatgpt_account_id":"chatgpt"
            }
        }));
        assert_eq!(
            account_id_from_access_token(&access).as_deref(),
            Some("chatgpt")
        );
        let raw = json!({"tokens":{"account_id":"stored"}})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(codex_account_id(&raw, &access).as_deref(), Some("stored"));

        let subject_only = token(json!({"sub":"subject"}));
        assert_eq!(
            account_id_from_access_token(&subject_only).as_deref(),
            Some("subject")
        );
        assert_eq!(codex_account_id(&Map::new(), &subject_only), None);
    }
    // url and standard base64 payloads match node buffer inputs
    {
        let bytes = serde_json::to_vec(&json!({
            "sub":"source-account", "email":"person@example.com"
        }))
        .unwrap();
        for encoded in [
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes),
            base64::engine::general_purpose::STANDARD.encode(&bytes),
        ] {
            let token = format!("head.{encoded}.signature");
            assert_eq!(
                account_id_from_access_token(&token).as_deref(),
                Some("source-account")
            );
            assert_eq!(
                email_from_access_token(&token).as_deref(),
                Some("person@example.com")
            );
        }
    }
}
