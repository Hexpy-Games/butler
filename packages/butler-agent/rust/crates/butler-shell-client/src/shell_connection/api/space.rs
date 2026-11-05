use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// POST /space/groups
    pub async fn create_space_groups(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["space", "groups"], &[], Some(body))
            .await
    }
    /// POST /space/moves
    pub async fn create_space_moves(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["space", "moves"], &[], Some(body))
            .await
    }
    /// POST /space/group-sessions
    pub async fn create_space_group_sessions(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["space", "group-sessions"], &[], Some(body))
            .await
    }
    /// POST /space/undo
    pub async fn create_space_undo(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["space", "undo"], &[], Some(body))
            .await
    }
    /// POST /space/pins
    pub async fn create_space_pins(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["space", "pins"], &[], Some(body))
            .await
    }
    /// POST /space/relocations
    pub async fn create_space_relocations(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["space", "relocations"], &[], Some(body))
            .await
    }
    /// POST /space/branches
    pub async fn create_space_branches(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["space", "branches"], &[], Some(body))
            .await
    }
    /// POST /space/branch-source
    pub async fn create_space_branch_source(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["space", "branch-source"], &[], Some(body))
            .await
    }
    /// PATCH /space/groups/{group_id}
    pub async fn update_space_group(&self, group_id: &str, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::PATCH,
            &["space", "groups", group_id],
            &[],
            Some(body),
        )
        .await
    }
    /// DELETE /space/groups/{group_id}
    pub async fn delete_space_group(&self, group_id: &str, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::DELETE,
            &["space", "groups", group_id],
            &[],
            Some(body),
        )
        .await
    }
}
