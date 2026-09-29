use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::json;

use super::Fixture;

/// Called by `cursor_decoder_accepts_integral_json_number_spellings`: one
/// test covers the cursor decoder's tolerated spellings.
pub(super) async fn cursor_decoder_accepts_runtime_tolerated_base64url_spellings() {
    let fixture = Fixture::new();
    fixture.write("long.txt", b"one two three four");
    let first = json!({ "arguments": { "requests": [{ "path": "long.txt", "max_bytes": 4 }] } });
    let cursor = fixture.invoke(&first, None).await["next_cursor"]
        .as_str()
        .unwrap()
        .to_owned();
    let split = cursor.len() / 2;
    let junk = format!("{} \n!{}", &cursor[..split], &cursor[split..]);
    let padded_suffix = format!("{cursor}=ignored");
    let mut payload = URL_SAFE_NO_PAD.decode(&cursor).unwrap();
    while payload.len() % 3 == 0 {
        payload.push(b' ');
    }
    let canonical = URL_SAFE_NO_PAD.encode(payload);
    let mut low_bits = canonical.into_bytes();
    let last = low_bits.len() - 1;
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let position = alphabet
        .iter()
        .position(|value| *value == low_bits[last])
        .unwrap();
    low_bits[last] = alphabet[position | 1];
    let trailing_bits = String::from_utf8(low_bits).unwrap();
    for mutated in [junk, padded_suffix, trailing_bits] {
        let call = json!({ "arguments": { "requests": [{ "path": "long.txt", "max_bytes": 4 }], "cursor": mutated } });
        let rust = fixture.invoke(&call, None).await;
        assert_ne!(rust["error"], "invalid_cursor", "cursor: {mutated}");
    }
    fixture.files.close().await;
}

pub(crate) async fn containment_and_unicode_sensitive_paths_are_rejected() {
    let fixture = Fixture::new();
    fixture.write("..near.txt", b"near");
    fixture.write("secret.Key", b"secret");
    for path in ["..near.txt", "secret.Key"] {
        let call = json!({ "arguments": { "requests": [{ "path": path }] } });
        let rust = fixture.invoke(&call, None).await;
        assert_eq!(rust["files"][0]["ok"], false);
    }
    fixture.files.close().await;
}
