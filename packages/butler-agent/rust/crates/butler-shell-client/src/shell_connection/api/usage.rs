use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /usage-history
    pub async fn get_usage_history(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["usage-history"], &[], None).await
    }
    /// GET /usage-monitor?session_id&since_hours
    pub async fn get_usage_monitor(
        &self,
        session_id: Option<&str>,
        since_hours: Option<f64>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = session_id {
            query.push(("session_id", value.to_string()));
        }
        if let Some(value) = since_hours {
            query.push(("since_hours", value.to_string()));
        }
        self.json(Method::GET, &["usage-monitor"], &query, None)
            .await
    }
    /// GET /usage/images?days
    pub async fn get_image_usage(&self, days: u32) -> Result<Value, Error> {
        self.json(
            Method::GET,
            &["usage", "images"],
            &[("days", days.to_string())],
            None,
        )
        .await
    }
    /// GET /provider-quota?provider_id
    pub async fn get_provider_quota(&self, provider_id: &str) -> Result<Value, Error> {
        self.json(
            Method::GET,
            &["provider-quota"],
            &[("provider_id", provider_id.to_string())],
            None,
        )
        .await
    }
    /// GET /system-events?limit&offset
    pub async fn list_system_events(
        &self,
        limit: Option<u32>,
        offset: Option<u64>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = limit {
            query.push(("limit", value.to_string()));
        }
        if let Some(value) = offset {
            query.push(("offset", value.to_string()));
        }
        self.json(Method::GET, &["system-events"], &query, None)
            .await
    }
}
