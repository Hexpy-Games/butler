use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /library?kind&q&cursor&url&kinds&group&tags&site&since&until&sort
    #[expect(
        clippy::too_many_arguments,
        reason = "desktop route query parameters remain explicit scalars"
    )]
    pub async fn list_library(
        &self,
        kind: Option<&str>,
        q: Option<&str>,
        cursor: Option<&str>,
        url: Option<&str>,
        kinds: Option<&str>,
        group: Option<&str>,
        tags: Option<&str>,
        site: Option<&str>,
        since: Option<&str>,
        until: Option<&str>,
        sort: Option<&str>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = kind {
            query.push(("kind", value.to_string()));
        }
        if let Some(value) = q {
            query.push(("q", value.to_string()));
        }
        if let Some(value) = cursor {
            query.push(("cursor", value.to_string()));
        }
        if let Some(value) = url {
            query.push(("url", value.to_string()));
        }
        if let Some(value) = kinds {
            query.push(("kinds", value.to_string()));
        }
        if let Some(value) = group {
            query.push(("group", value.to_string()));
        }
        if let Some(value) = tags {
            query.push(("tags", value.to_string()));
        }
        if let Some(value) = site {
            query.push(("site", value.to_string()));
        }
        if let Some(value) = since {
            query.push(("since", value.to_string()));
        }
        if let Some(value) = until {
            query.push(("until", value.to_string()));
        }
        if let Some(value) = sort {
            query.push(("sort", value.to_string()));
        }
        self.json(Method::GET, &["library"], &query, None).await
    }
    /// POST /library
    pub async fn save_library(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["library"], &[], Some(body)).await
    }
    /// DELETE /library/{id}
    pub async fn delete_library(&self, id: &str) -> Result<Value, Error> {
        self.json(Method::DELETE, &["library", id], &[], None).await
    }
    /// GET /library/{id}/snapshot
    pub async fn library_snapshot(&self, id: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["library", id, "snapshot"], &[], None)
            .await
    }
    /// POST /library/documents
    pub async fn save_library_document(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["library", "documents"], &[], Some(body))
            .await
    }
    /// POST /library/blocks
    pub async fn save_library_block(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["library", "blocks"], &[], Some(body))
            .await
    }
    /// GET /library/groups?kind
    pub async fn list_library_groups(&self, kind: Option<&str>) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = kind {
            query.push(("kind", value.to_string()));
        }
        self.json(Method::GET, &["library", "groups"], &query, None)
            .await
    }
    /// POST /library/groups
    pub async fn create_library_group(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["library", "groups"], &[], Some(body))
            .await
    }
    /// PATCH /library/groups/{id}
    pub async fn update_library_group(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.json(Method::PATCH, &["library", "groups", id], &[], Some(body))
            .await
    }
    /// DELETE /library/groups/{id}
    pub async fn delete_library_group(&self, id: &str) -> Result<Value, Error> {
        self.json(Method::DELETE, &["library", "groups", id], &[], None)
            .await
    }
    /// GET /library/tags
    pub async fn list_library_tags(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["library", "tags"], &[], None)
            .await
    }
    /// PATCH /library/tags
    pub async fn update_library_tags(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::PATCH, &["library", "tags"], &[], Some(body))
            .await
    }
    /// DELETE /library/tags/{name}
    pub async fn delete_library_tag(&self, name: &str) -> Result<Value, Error> {
        self.json(Method::DELETE, &["library", "tags", name], &[], None)
            .await
    }
    /// GET /library/facets?kind&kinds&group
    pub async fn get_library_facets(
        &self,
        kind: Option<&str>,
        kinds: Option<&str>,
        group: Option<&str>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = kind {
            query.push(("kind", value.to_string()));
        }
        if let Some(value) = kinds {
            query.push(("kinds", value.to_string()));
        }
        if let Some(value) = group {
            query.push(("group", value.to_string()));
        }
        self.json(Method::GET, &["library", "facets"], &query, None)
            .await
    }
    /// PATCH /library/items
    pub async fn update_library_items(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::PATCH, &["library", "items"], &[], Some(body))
            .await
    }
}
