use super::super::ModelConfiguration;
use super::{Error, authority::ChatGptAuthority, store};
use serde_json::Value;

impl ModelConfiguration {
    pub async fn chatgpt_sign_out(&self) -> Result<bool, Error> {
        let paths = self.chatgpt_paths().await?;
        let registration = store::read(&paths.registration).await?;
        let revoked = match registration["refresh_token"]
            .as_str()
            .filter(|s| !s.is_empty())
        {
            None => true,
            Some(token) => tokio::time::timeout(
                std::time::Duration::from_secs(5),
                revoke(
                    &self.chatgpt_authority,
                    token,
                    registration["client_id"].as_str().unwrap_or(""),
                ),
            )
            .await
            .unwrap_or(false),
        };
        if registration != serde_json::json!({}) {
            store::update(&paths, paths.registration.clone(), |raw| {
                raw["access_token"] = Value::Null;
                raw["refresh_token"] = Value::Null;
                raw["sign_in_required"] = "signed_out".into();
                raw["updated_at"] = chrono::Utc::now().to_rfc3339().into();
                Ok(())
            })
            .await?;
        }
        self.chatgpt_invalidate_models().await;
        self.provider_account_changed("openai");
        self.chatgpt_changed();
        Ok(revoked)
    }
}
async fn revoke(authority: &ChatGptAuthority, token: &str, client: &str) -> bool {
    let Ok(discovery) = authority.discovery().await else {
        return false;
    };
    let Ok(http) = authority.client() else {
        return false;
    };
    for attempt in 0..3 {
        let response = http
            .post(&discovery.revocation_endpoint)
            .phase(butler_log::http::Phase::current().sensitive())
            .form(&[
                ("token", token),
                ("token_type_hint", "refresh_token"),
                ("client_id", client),
            ])
            .send()
            .await;
        match response {
            Ok(response) if response.status() == reqwest::StatusCode::OK => return true,
            Ok(response) if !response.status().is_server_error() => return false,
            _ => {}
        }
        if attempt < 2 {
            tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
        }
    }
    false
}
