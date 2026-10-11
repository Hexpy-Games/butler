//! Functional smoke of the production headless executor against an offline echo host.
use butler_runtime::browser::{ContentOrigin, Headless, HeadlessConfig, InstallSource};
use serde_json::json;
use std::{path::PathBuf, time::Duration};
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("BUTLER_IDENTITY_FIXTURE_URL")?;
    let port = url::Url::parse(&url)?
        .port()
        .ok_or("fixture port missing")?;
    let root = PathBuf::from(std::env::var("BUTLER_DATA")?);
    let backend = Headless::new(
        HeadlessConfig {
            root: root.join("headless"),
            install: InstallSource {
                cache_root: root.join("cache"),
                base_url: None,
            },
            content: Some(ContentOrigin(port)),
            enabled: true,
        },
        CancellationToken::new(),
    );
    let result = async {
        let rendered = backend
            .render(&url, Duration::from_secs(20))
            .await
            .map_err(std::io::Error::other)?;
        let opened = backend
            .execute(json!({"op":"tab.open","session":"identity","args":{"url":url}}))
            .await;
        let observed = backend
            .execute(json!({"op":"tab.observe","session":"identity","tab":opened["tab"],"args":{}}))
            .await;
        let report = json!({"html":rendered.html,"opened":opened,"observed":observed});
        std::fs::write(
            std::env::var("BUTLER_IDENTITY_RESULT")?,
            serde_json::to_vec_pretty(&report)?,
        )?;
        Ok::<(), Box<dyn std::error::Error>>(())
    }
    .await;
    backend.shutdown().await;
    result
}
