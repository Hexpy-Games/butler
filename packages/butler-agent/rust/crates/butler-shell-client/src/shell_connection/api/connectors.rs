//! Security-admin bridge calls from Electron `connectionsApi.ts`.
use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// Electron `connectionsApi.ts`: list_plugins.
    pub async fn list_plugins(&self) -> Result<Value, Error> {
        self.admin_json(Method::GET, &["plugins"], &[], None).await
    }

    /// Electron `connectionsApi.ts`: inspect_bundled_plugin.
    pub async fn inspect_bundled_plugin(&self, body: &Value) -> Result<Value, Error> {
        self.admin_json(Method::POST, &["plugins", "inspect"], &[], Some(body))
            .await
    }

    /// Electron `connectionsApi.ts`: install_plugin.
    pub async fn install_plugin(&self, body: &Value) -> Result<Value, Error> {
        self.admin_json(Method::POST, &["plugins", "install"], &[], Some(body))
            .await
    }

    /// Electron `connectionsApi.ts`: check_plugin.
    pub async fn check_plugin(&self, name: &str, body: &Value) -> Result<Value, Error> {
        self.admin_json(Method::POST, &["plugins", name, "check"], &[], Some(body))
            .await
    }

    /// Electron `connectionsApi.ts`: update_plugin.
    pub async fn update_plugin(&self, name: &str, body: &Value) -> Result<Value, Error> {
        self.admin_json(Method::POST, &["plugins", name, "update"], &[], Some(body))
            .await
    }

    /// Electron `connectionsApi.ts`: list_connectors.
    pub async fn list_connectors(&self) -> Result<Value, Error> {
        self.admin_json(Method::GET, &["connectors"], &[], None)
            .await
    }

    /// Electron `connectionsApi.ts`: add_connector_account.
    pub async fn add_connector_account(
        &self,
        connector: &str,
        body: &Value,
    ) -> Result<Value, Error> {
        let (plugin, connector) = connector.split_once('/').ok_or(Error::Protocol)?;
        self.admin_json(
            Method::POST,
            &["connectors", plugin, connector, "accounts"],
            &[],
            Some(body),
        )
        .await
    }

    /// Electron `connectionsApi.ts`: retry_connector_account.
    pub async fn retry_connector_account(
        &self,
        connector: &str,
        id: &str,
        body: &Value,
    ) -> Result<Value, Error> {
        let (plugin, connector) = connector.split_once('/').ok_or(Error::Protocol)?;
        self.admin_json(
            Method::POST,
            &["connectors", plugin, connector, "accounts", id, "retry"],
            &[],
            Some(body),
        )
        .await
    }

    /// Electron `connectionsApi.ts`: remove_connector_account.
    pub async fn remove_connector_account(
        &self,
        connector: &str,
        id: &str,
        revision: u64,
    ) -> Result<Value, Error> {
        let (plugin, connector) = connector.split_once('/').ok_or(Error::Protocol)?;
        self.admin_json(
            Method::DELETE,
            &["connectors", plugin, connector, "accounts", id],
            &[("revision", revision.to_string())],
            None,
        )
        .await
    }

    /// Electron `connectionsApi.ts`: list_connector_rules.
    pub async fn list_connector_rules(&self) -> Result<Value, Error> {
        self.admin_json(Method::GET, &["connector-rules"], &[], None)
            .await
    }

    /// Electron `connectionsApi.ts`: delete_connector_rule.
    pub async fn delete_connector_rule(&self, id: &str) -> Result<Value, Error> {
        self.admin_json(Method::DELETE, &["connector-rules", id], &[], None)
            .await
    }
}
