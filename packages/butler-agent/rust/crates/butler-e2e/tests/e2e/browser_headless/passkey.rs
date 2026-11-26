//! Public browser-tool passkey requests on the hidden-App executor.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::support::{admin, call, hidden_app, open, publish_as, setup};
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};

pub(super) const PAGE: &str = r"<!doctype html><meta charset=utf-8><title>Passkey fixture</title>
<p id=result>Passkey pending</p><script>
const key={challenge:new Uint8Array(32),timeout:60000};
const make={publicKey:{...key,rp:{name:'Fixture'},user:{id:new Uint8Array(16),name:'fixture',displayName:'Fixture'},pubKeyCredParams:[{type:'public-key',alg:-7}]}};
const run=call=>call().then(()=>'resolved',e=>e.name);
Promise.all([run(()=>navigator.credentials.create(make)),run(()=>navigator.credentials.get({publicKey:key}))])
  .then(([create,get])=>document.querySelector('#result').textContent='Passkey:'+JSON.stringify({secure:isSecureContext,create,get}));
</script>";

// test-category: e2e
#[tokio::test]
async fn passkey_requests_end_without_os_ui() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        hidden_app(),
        "Butler preload runs only on the hidden App host"
    );
    butler_e2e::skip_unless!(
        butler_platform::instance::os_name() != "windows",
        "Windows shows the OS passkey sheet"
    );
    let s = setup("BROWSER-PASSKEY")?.start().await?;
    let admin = admin(&s);
    let (_, url) = publish_as(&s, "Publish passkey").await?;
    let opened = open(&admin, "general", &url).await?;
    assert_eq!(opened["status"], "ok", "{opened}");
    let observed = call(&admin, "general", "tab.observe", &opened["tab"], json!({})).await?;
    assert_eq!(observed["status"], "ok", "{observed}");
    let text = observed["text"].as_str().unwrap();
    let line = text
        .lines()
        .find_map(|line| line.split_once("Passkey:").map(|(_, value)| value))
        .expect("complete passkey report");
    let report: Value = serde_json::from_str(line)?;
    assert_eq!(report["secure"], true);
    assert_eq!(report["create"], "NotAllowedError");
    assert_eq!(report["get"], "NotAllowedError");
    call(&admin, "general", "tab.close", &opened["tab"], json!({})).await?;
    s.finish().await
}
