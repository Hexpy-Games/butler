use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /security/signins (admin)
    pub async fn list_sign_ins(&self) -> Result<Value, Error> {
        self.admin_json(Method::GET, &["security", "signins"], &[], None)
            .await
    }
    /// POST /security/signins (admin)
    pub async fn add_sign_in(&self, body: &Value) -> Result<Value, Error> {
        self.admin_json(Method::POST, &["security", "signins"], &[], Some(body))
            .await
    }
    /// PATCH /security/signins/{id} (admin)
    pub async fn update_sign_in(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.admin_json(Method::PATCH, &["security", "signins", id], &[], Some(body))
            .await
    }
    /// DELETE /security/signins/{id} (admin)
    pub async fn delete_sign_in(&self, id: &str) -> Result<Value, Error> {
        self.admin_json(Method::DELETE, &["security", "signins", id], &[], None)
            .await
    }
    /// POST /security/signins/site (admin)
    pub async fn update_sign_in_site(&self, body: &Value) -> Result<Value, Error> {
        self.admin_json(
            Method::POST,
            &["security", "signins", "site"],
            &[],
            Some(body),
        )
        .await
    }
    /// GET /security/vault (admin)
    pub async fn list_vault(&self) -> Result<Value, Error> {
        self.admin_json(Method::GET, &["security", "vault"], &[], None)
            .await
    }
    /// POST /security/vault/cards (admin)
    pub async fn add_vault_card(&self, body: &Value) -> Result<Value, Error> {
        self.admin_json(
            Method::POST,
            &["security", "vault", "cards"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /security/vault/profiles (admin)
    pub async fn add_vault_profile(&self, body: &Value) -> Result<Value, Error> {
        self.admin_json(
            Method::POST,
            &["security", "vault", "profiles"],
            &[],
            Some(body),
        )
        .await
    }
    /// PATCH /security/vault/cards/{id} (admin)
    pub async fn update_vault_card(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.admin_json(
            Method::PATCH,
            &["security", "vault", "cards", id],
            &[],
            Some(body),
        )
        .await
    }
    /// PATCH /security/vault/profiles/{id} (admin)
    pub async fn update_vault_profile(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.admin_json(
            Method::PATCH,
            &["security", "vault", "profiles", id],
            &[],
            Some(body),
        )
        .await
    }
    /// DELETE /security/vault/cards/{id} (admin)
    pub async fn delete_vault_card(&self, id: &str) -> Result<Value, Error> {
        self.admin_json(
            Method::DELETE,
            &["security", "vault", "cards", id],
            &[],
            None,
        )
        .await
    }
    /// DELETE /security/vault/profiles/{id} (admin)
    pub async fn delete_vault_profile(&self, id: &str) -> Result<Value, Error> {
        self.admin_json(
            Method::DELETE,
            &["security", "vault", "profiles", id],
            &[],
            None,
        )
        .await
    }
    /// POST /security/vault/cards/{id}/sites (admin)
    pub async fn set_vault_card_site(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.admin_json(
            Method::POST,
            &["security", "vault", "cards", id, "sites"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /security/vault/profiles/{id}/sites (admin)
    pub async fn set_vault_profile_site(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.admin_json(
            Method::POST,
            &["security", "vault", "profiles", id, "sites"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /security/vault/cards/{id}/reveal (admin)
    pub async fn reveal_vault_card(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.admin_json(
            Method::POST,
            &["security", "vault", "cards", id, "reveal"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /security/vault/profiles/{id}/reveal (admin)
    pub async fn reveal_vault_profile(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.admin_json(
            Method::POST,
            &["security", "vault", "profiles", id, "reveal"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /security/vault/purchase-sites (admin)
    pub async fn set_purchase_site(&self, body: &Value) -> Result<Value, Error> {
        self.admin_json(
            Method::POST,
            &["security", "vault", "purchase-sites"],
            &[],
            Some(body),
        )
        .await
    }
}
