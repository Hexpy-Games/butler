//! Reversible projection identities; no additional persistent entity or writer.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
pub fn encode(prefix: &str, first: &str, second: &str) -> String {
    format!(
        "{prefix}{}",
        URL_SAFE_NO_PAD.encode(serde_json::json!([first, second]).to_string())
    )
}
pub fn decode(id: &str, prefix: &str) -> Option<(String, String)> {
    let bytes = URL_SAFE_NO_PAD.decode(id.strip_prefix(prefix)?).ok()?;
    let pair: [String; 2] = serde_json::from_slice(&bytes).ok()?;
    let [first, second] = pair;
    Some((first, second))
}
