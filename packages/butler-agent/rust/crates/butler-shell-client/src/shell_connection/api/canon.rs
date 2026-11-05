use crate::{Error, ShellClient, Upload};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /projects/{project_id}/canon
    pub async fn get_canon(&self, project_id: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["projects", project_id, "canon"], &[], None)
            .await
    }
    /// GET /projects/{project_id}/canon/tags
    pub async fn get_canon_tags(&self, project_id: &str) -> Result<Value, Error> {
        self.json(
            Method::GET,
            &["projects", project_id, "canon", "tags"],
            &[],
            None,
        )
        .await
    }
    /// POST /projects/{project_id}/canon/tags
    pub async fn create_canon_tag(&self, project_id: &str, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["projects", project_id, "canon", "tags"],
            &[],
            Some(body),
        )
        .await
    }
    /// PATCH /canon/tags/{id}
    pub async fn edit_canon_tag(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.json(Method::PATCH, &["canon", "tags", id], &[], Some(body))
            .await
    }
    /// DELETE /canon/tags/{id}
    pub async fn delete_canon_tag(&self, id: &str) -> Result<Value, Error> {
        self.json(Method::DELETE, &["canon", "tags", id], &[], None)
            .await
    }
    /// POST /projects/{project_id}/canon/plans
    pub async fn create_canon_plan(&self, project_id: &str, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["projects", project_id, "canon", "plans"],
            &[],
            Some(body),
        )
        .await
    }
    /// GET /canon/plans/{id}
    pub async fn get_canon_plan(&self, id: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["canon", "plans", id], &[], None)
            .await
    }
    /// PATCH /canon/plans/{id}
    pub async fn edit_canon_plan(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.json(Method::PATCH, &["canon", "plans", id], &[], Some(body))
            .await
    }
    /// POST /canon/plans/{id}/order
    pub async fn order_canon_plan(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["canon", "plans", id, "order"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /projects/{project_id}/canon/backlog/order
    pub async fn order_canon_backlog(
        &self,
        project_id: &str,
        body: &Value,
    ) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["projects", project_id, "canon", "backlog", "order"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /projects/{project_id}/canon/epics
    pub async fn create_canon_epic(&self, project_id: &str, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["projects", project_id, "canon", "epics"],
            &[],
            Some(body),
        )
        .await
    }
    /// GET /canon/epics/{id}
    pub async fn get_canon_epic(&self, id: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["canon", "epics", id], &[], None)
            .await
    }
    /// PATCH /canon/epics/{id}
    pub async fn edit_canon_epic(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.json(Method::PATCH, &["canon", "epics", id], &[], Some(body))
            .await
    }
    /// DELETE /canon/epics/{id}
    pub async fn delete_canon_epic(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.json(Method::DELETE, &["canon", "epics", id], &[], Some(body))
            .await
    }
    /// GET /canon/epics/{id}/progress
    pub async fn get_epic_progress(&self, id: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["canon", "epics", id, "progress"], &[], None)
            .await
    }
    /// GET /canon/epics/{id}/activity?before
    pub async fn get_canon_activity(&self, id: &str, before: Option<&str>) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = before {
            query.push(("before", value.to_string()));
        }
        self.json(
            Method::GET,
            &["canon", "epics", id, "activity"],
            &query,
            None,
        )
        .await
    }
    /// POST /canon/epics/{id}/conversation
    pub async fn link_canon_conversation(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["canon", "epics", id, "conversation"],
            &[],
            Some(body),
        )
        .await
    }
    /// GET /projects/{project_id}/canon/sidebar
    pub async fn get_canon_sidebar(&self, project_id: &str) -> Result<Value, Error> {
        self.json(
            Method::GET,
            &["projects", project_id, "canon", "sidebar"],
            &[],
            None,
        )
        .await
    }
    /// POST /projects/{project_id}/canon/sidebar-order
    pub async fn order_canon_sidebar(
        &self,
        project_id: &str,
        body: &Value,
    ) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["projects", project_id, "canon", "sidebar-order"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /canon/specs/{id}/criteria/{criterion_id}
    pub async fn check_canon_criterion(
        &self,
        id: &str,
        criterion_id: &str,
        body: &Value,
    ) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["canon", "specs", id, "criteria", criterion_id],
            &[],
            Some(body),
        )
        .await
    }
    /// GET /canon/proposals/{id}
    pub async fn get_canon_proposal(&self, id: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["canon", "proposals", id], &[], None)
            .await
    }
    /// POST /canon/proposals/{id}
    pub async fn resolve_canon_proposal(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["canon", "proposals", id], &[], Some(body))
            .await
    }
    /// GET /canon/mcp-grants?state
    pub async fn get_canon_grants(&self, state: Option<&str>) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = state {
            query.push(("state", value.to_string()));
        }
        self.json(Method::GET, &["canon", "mcp-grants"], &query, None)
            .await
    }
    /// POST /canon/mcp-grants/{id}/allow
    pub async fn allow_canon_grant(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["canon", "mcp-grants", id, "allow"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /canon/mcp-grants/{id}/deny
    pub async fn deny_canon_grant(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["canon", "mcp-grants", id, "deny"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /canon/mcp-grants/{id}/revoke
    pub async fn revoke_canon_grant(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["canon", "mcp-grants", id, "revoke"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /projects/{project_id}/canon/files (multipart: file).
    pub async fn upload_canon_file(&self, project_id: &str, file: &Upload) -> Result<Value, Error> {
        self.upload(&["projects", project_id, "canon", "files"], &[], &[], file)
            .await
    }
}
