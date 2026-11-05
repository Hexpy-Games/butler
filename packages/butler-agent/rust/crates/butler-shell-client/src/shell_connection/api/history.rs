use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /browser-history?q&butlerOnly&cursor
    pub async fn list_browser_history(
        &self,
        q: Option<&str>,
        butler_only: Option<bool>,
        cursor: Option<&str>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = q {
            query.push(("q", value.to_string()));
        }
        if let Some(value) = butler_only {
            query.push(("butlerOnly", value.to_string()));
        }
        if let Some(value) = cursor {
            query.push(("cursor", value.to_string()));
        }
        self.json(Method::GET, &["browser-history"], &query, None)
            .await
    }
    /// GET /browser-history/suggestions?q
    pub async fn get_browser_history_suggestions(&self, q: &str) -> Result<Value, Error> {
        self.json(
            Method::GET,
            &["browser-history", "suggestions"],
            &[("q", q.to_string())],
            None,
        )
        .await
    }
    /// POST /browser-history/delete
    pub async fn delete_browser_history(&self, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["browser-history", "delete"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /browser-history/delete-url
    pub async fn delete_browser_history_url(&self, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["browser-history", "delete-url"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /browser-history/clear
    pub async fn clear_browser_history(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["browser-history", "clear"], &[], Some(body))
            .await
    }
}
