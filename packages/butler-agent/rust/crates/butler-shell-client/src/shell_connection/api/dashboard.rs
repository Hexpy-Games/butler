use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /projects/{project_id}/dashboard/records?kind&parent&cursor&limit&lane
    pub async fn get_project_dashboard_records(
        &self,
        project_id: &str,
        kind: Option<&str>,
        parent: Option<&str>,
        cursor: Option<&str>,
        limit: Option<u32>,
        lane: Option<&str>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = kind {
            query.push(("kind", value.to_string()));
        }
        if let Some(value) = parent {
            query.push(("parent", value.to_string()));
        }
        if let Some(value) = cursor {
            query.push(("cursor", value.to_string()));
        }
        if let Some(value) = limit {
            query.push(("limit", value.to_string()));
        }
        if let Some(value) = lane {
            query.push(("lane", value.to_string()));
        }
        self.json(
            Method::GET,
            &["projects", project_id, "dashboard", "records"],
            &query,
            None,
        )
        .await
    }
    /// GET /projects/{project_id}/dashboard/materials?cursor&limit&all&important
    pub async fn get_project_dashboard_materials(
        &self,
        project_id: &str,
        cursor: Option<&str>,
        limit: Option<u32>,
        all: Option<bool>,
        important: Option<bool>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = cursor {
            query.push(("cursor", value.to_string()));
        }
        if let Some(value) = limit {
            query.push(("limit", value.to_string()));
        }
        if let Some(value) = all {
            query.push(("all", value.to_string()));
        }
        if let Some(value) = important {
            query.push(("important", value.to_string()));
        }
        self.json(
            Method::GET,
            &["projects", project_id, "dashboard", "materials"],
            &query,
            None,
        )
        .await
    }
    /// GET /projects/{project_id}/dashboard/source?kind&id&revision&cursor
    pub async fn get_project_dashboard_source(
        &self,
        project_id: &str,
        kind: &str,
        id: &str,
        revision: &str,
        cursor: Option<&str>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        query.push(("kind", kind.to_string()));
        query.push(("id", id.to_string()));
        query.push(("revision", revision.to_string()));
        if let Some(value) = cursor {
            query.push(("cursor", value.to_string()));
        }
        self.json(
            Method::GET,
            &["projects", project_id, "dashboard", "source"],
            &query,
            None,
        )
        .await
    }
    /// GET /projects/{project_id}/dashboard/history?cursor&limit&all&important
    pub async fn get_project_dashboard_history(
        &self,
        project_id: &str,
        cursor: Option<&str>,
        limit: Option<u32>,
        all: Option<bool>,
        important: Option<bool>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = cursor {
            query.push(("cursor", value.to_string()));
        }
        if let Some(value) = limit {
            query.push(("limit", value.to_string()));
        }
        if let Some(value) = all {
            query.push(("all", value.to_string()));
        }
        if let Some(value) = important {
            query.push(("important", value.to_string()));
        }
        self.json(
            Method::GET,
            &["projects", project_id, "dashboard", "history"],
            &query,
            None,
        )
        .await
    }
    /// GET /projects/{project_id}/dashboard/artifacts?cursor&limit&all&important
    pub async fn get_project_dashboard_artifacts(
        &self,
        project_id: &str,
        cursor: Option<&str>,
        limit: Option<u32>,
        all: Option<bool>,
        important: Option<bool>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = cursor {
            query.push(("cursor", value.to_string()));
        }
        if let Some(value) = limit {
            query.push(("limit", value.to_string()));
        }
        if let Some(value) = all {
            query.push(("all", value.to_string()));
        }
        if let Some(value) = important {
            query.push(("important", value.to_string()));
        }
        self.json(
            Method::GET,
            &["projects", project_id, "dashboard", "artifacts"],
            &query,
            None,
        )
        .await
    }
    /// GET /projects/{project_id}/dashboard/statistics?days&timezone
    pub async fn get_project_dashboard_statistics(
        &self,
        project_id: &str,
        days: Option<u32>,
        timezone: Option<&str>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = days {
            query.push(("days", value.to_string()));
        }
        if let Some(value) = timezone {
            query.push(("timezone", value.to_string()));
        }
        self.json(
            Method::GET,
            &["projects", project_id, "dashboard", "statistics"],
            &query,
            None,
        )
        .await
    }
}
