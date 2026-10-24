//! Offline search companion: product provider stack with local fixture endpoints.
use butler_models::models::{
    ModelCatalog, ModelConfiguration, ModelConfigurationClock, ModelConfigurationEnvironment,
};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
struct Clock;
impl ModelConfigurationClock for Clock {
    fn now_iso(&self) -> String {
        chrono::Utc::now().to_rfc3339()
    }
    fn now_epoch_millis(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let data = std::path::PathBuf::from(&args[1]);
    let config = Arc::new(ModelConfiguration::new(
        data.clone(),
        ModelConfigurationEnvironment {
            chatgpt_api_base_url: Some(args[2].clone()),
            ..Default::default()
        },
        Arc::new(Clock),
        Arc::new(ModelCatalog::new()?),
        Arc::new(butler_core::locale::LocaleCollation::new("en-US")?),
        butler_models::models::provider_http_client()?,
        Arc::new(butler_core::configuration::ConfigurationWrites::new()),
    )?);
    let access =
        butler_runtime::web_access::testing::access_with_configuration(data, &args[3], config);
    let mut input = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(query) = input.next_line().await? {
        let result = access
            .search_test(&query, &tokio_util::sync::CancellationToken::new())
            .await;
        let value = match result {
            Ok(value) => value,
            Err(error) => serde_json::json!({"error":error.code()}),
        };
        stdout.write_all(format!("{value}\n").as_bytes()).await?;
        stdout.flush().await?;
    }
    Ok(())
}
