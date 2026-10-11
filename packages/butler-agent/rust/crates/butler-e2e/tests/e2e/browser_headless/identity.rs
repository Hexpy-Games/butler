//! Public browser-tool identity on the headless and hidden-App executors.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::support::{admin, call, open, publish_as, selected, setup};
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};

pub(super) const PAGE: &str = r#"<!doctype html><meta charset=utf-8><title>Identity fixture</title>
<p id=result>Identity pending</p><script>
const read=async()=>({ua:navigator.userAgent,data:await navigator.userAgentData.getHighEntropyValues(['fullVersionList','platformVersion','architecture','bitness'])});
const reports={};const save=(name,value)=>{reports[name]=value;if(reports.page&&reports.worker&&reports.frame)document.querySelector('#result').textContent='Identity:'+JSON.stringify(reports)};
read().then(v=>save('page',v));
const worker=new Worker(URL.createObjectURL(new Blob(['('+read.toString()+')().then(postMessage)'],{type:'text/javascript'})));
worker.onmessage=e=>{save('worker',e.data);worker.terminate()};
addEventListener('message',e=>{if(e.data.frame)save('frame',e.data.frame)});
const frame=document.createElement('iframe');frame.srcdoc='<script>('+read.toString()+')().then(v=>parent.postMessage({frame:v},"*"))<\/script>';document.body.append(frame);
</script>"#;

#[tokio::test]
async fn browser_identity_agrees_in_page_worker_and_frame() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(selected(), "explicit browser backend required");
    let s = setup("BROWSER-IDENTITY")?.start().await?;
    let admin = admin(&s);
    let (_, url) = publish_as(&s, "Publish identity").await?;
    let opened = open(&admin, "general", &url).await?;
    assert_eq!(opened["status"], "ok", "{opened}");
    let observed = call(&admin, "general", "tab.observe", &opened["tab"], json!({})).await?;
    assert_eq!(observed["status"], "ok", "{observed}");
    let text = observed["text"].as_str().unwrap();
    let line = text
        .lines()
        .find_map(|line| line.split_once("Identity:").map(|(_, value)| value))
        .expect("complete identity report");
    let reports: Value = serde_json::from_str(line)?;
    let ua = reports["page"]["ua"].as_str().unwrap();
    assert!(
        !["Butler/", "Electron/", "HeadlessChrome/"]
            .iter()
            .any(|token| ua.contains(token)),
        "{ua}"
    );
    let full = ua
        .split("Chrome/")
        .nth(1)
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap();
    let major = full.split('.').next().unwrap();
    for name in ["page", "worker", "frame"] {
        let report = &reports[name];
        assert_eq!(report["ua"], ua, "{name}");
        assert_eq!(report["data"], reports["page"]["data"], "{name}");
        for brand in ["Chromium", "Google Chrome"] {
            assert!(
                report["data"]["brands"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|b| b["brand"] == brand && b["version"] == major)
            );
            assert!(
                report["data"]["fullVersionList"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|b| b["brand"] == brand && b["version"] == full)
            );
        }
        assert_eq!(report["data"]["mobile"], false);
    }
    call(&admin, "general", "tab.close", &opened["tab"], json!({})).await?;
    s.finish().await
}
