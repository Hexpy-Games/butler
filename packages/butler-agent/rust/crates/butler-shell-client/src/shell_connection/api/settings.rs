use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /settings
    pub async fn get_settings(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["settings"], &[], None).await
    }
    /// PATCH /settings. The caller must not send `security`; admin settings are out of scope.
    pub async fn update_settings(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::PATCH, &["settings"], &[], Some(body))
            .await
    }
    /// GET /app-info
    pub async fn get_app_info(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["app-info"], &[], None).await
    }
    /// GET /personalization
    pub async fn get_personalization(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["personalization"], &[], None)
            .await
    }
    /// PATCH /personalization
    pub async fn update_personalization(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::PATCH, &["personalization"], &[], Some(body))
            .await
    }
    /// GET /personalization/profile-import-prompt?locale
    pub async fn get_profile_import_prompt(&self, locale: Option<&str>) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = locale {
            query.push(("locale", value.to_string()));
        }
        self.json(
            Method::GET,
            &["personalization", "profile-import-prompt"],
            &query,
            None,
        )
        .await
    }
    /// POST /personalization/profile-import
    pub async fn import_personalization_profile(&self, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["personalization", "profile-import"],
            &[],
            Some(body),
        )
        .await
    }
}
