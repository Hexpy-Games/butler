use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use sha2::Sha256;

pub(super) fn expired(url: &str, token: &str) -> String {
    let parsed = reqwest::Url::parse(url).unwrap();
    let cap = parsed.path().split('/').nth(2).unwrap();
    let payload = String::from_utf8(
        URL_SAFE_NO_PAD
            .decode(cap.split('.').next().unwrap())
            .unwrap(),
    )
    .unwrap();
    let (output, _) = payload.rsplit_once(':').unwrap();
    let payload = URL_SAFE_NO_PAD.encode(format!("{output}:1"));
    let mut derive = Hmac::<Sha256>::new_from_slice(token.as_bytes()).unwrap();
    derive.update(b"butler-output-capability-v1");
    let key = derive.finalize().into_bytes();
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).unwrap();
    mac.update(payload.as_bytes());
    url.replace(
        cap,
        &format!(
            "{payload}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        ),
    )
}
