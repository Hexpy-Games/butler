use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /projects?include_sessions
    pub async fn list_projects(&self, include_sessions: bool) -> Result<Value, Error> {
        self.json(
            Method::GET,
            &["projects"],
            &[("include_sessions", include_sessions.to_string())],
            None,
        )
        .await
    }
    /// GET /project-folders?path&after (api.ts `listProjectFolders`)
    pub async fn list_project_folders(
        &self,
        path: &str,
        after: Option<&str>,
    ) -> Result<Value, Error> {
        let mut query = vec![("path", path.to_string())];
        if let Some(value) = after {
            query.push(("after", value.to_string()));
        }
        self.json(Method::GET, &["project-folders"], &query, None)
            .await
    }
    /// POST /projects
    pub async fn create_project(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["projects"], &[], Some(body))
            .await
    }
    /// PATCH /projects/{project_id}
    pub async fn update_project(&self, project_id: &str, body: &Value) -> Result<Value, Error> {
        self.json(Method::PATCH, &["projects", project_id], &[], Some(body))
            .await
    }
    /// DELETE /projects/{project_id}?permanent
    pub async fn delete_project(
        &self,
        project_id: &str,
        permanent: Option<bool>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = permanent {
            query.push(("permanent", value.to_string()));
        }
        self.json(Method::DELETE, &["projects", project_id], &query, None)
            .await
    }
    /// POST /projects/{project_id}/archive
    pub async fn archive_project(&self, project_id: &str) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["projects", project_id, "archive"],
            &[],
            Some(&serde_json::json!({})),
        )
        .await
    }
    /// POST /projects/{project_id}/pin
    pub async fn pin_project(&self, project_id: &str, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["projects", project_id, "pin"],
            &[],
            Some(body),
        )
        .await
    }
    /// GET /project-sessions?project_id
    pub async fn list_project_sessions(&self, project_id: Option<&str>) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = project_id {
            query.push(("project_id", value.to_string()));
        }
        self.json(Method::GET, &["project-sessions"], &query, None)
            .await
    }
    /// GET /projects/{project_id}/dashboard
    pub async fn get_project_dashboard(&self, project_id: &str) -> Result<Value, Error> {
        self.json(
            Method::GET,
            &["projects", project_id, "dashboard"],
            &[],
            None,
        )
        .await
    }
    /// PATCH /projects/{project_id}/dashboard/preferences
    pub async fn update_project_dashboard_preferences(
        &self,
        project_id: &str,
        body: &Value,
    ) -> Result<Value, Error> {
        self.json(
            Method::PATCH,
            &["projects", project_id, "dashboard", "preferences"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /projects/{project_id}/dashboard/briefing
    pub async fn create_project_dashboard_briefing(
        &self,
        project_id: &str,
        body: &Value,
    ) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["projects", project_id, "dashboard", "briefing"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /projects/{project_id}/dashboard/attachment
    pub async fn create_project_dashboard_attachment(
        &self,
        project_id: &str,
        body: &Value,
    ) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["projects", project_id, "dashboard", "attachment"],
            &[],
            Some(body),
        )
        .await
    }
}
