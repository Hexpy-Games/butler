//! Publishes an immutable Library revision with the Butler account.
use std::{
    fs::File,
    io::{self, Read},
    path::PathBuf,
};

use butler_gateway::gateway::{GatewayApplicationError, PublishSource, PublishingRequest};
use butler_log::http::Phase;
use butler_models::models::message_file_path;
use butler_runtime::outputs::OutputStore;
use reqwest::{Method, Response, StatusCode, header::CONTENT_TYPE};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::butler_account::{ButlerAccount, StoredAccount, check, signed_out, unavailable};

#[derive(Serialize)]
struct ManifestFile {
    path: String,
    sha256: String,
    size: u64,
}

enum Content {
    Output { output_id: String, revision: u64 },
    File(PathBuf),
}

struct Manifest {
    content: Content,
    entry: String,
    files: Vec<ManifestFile>,
    size_bytes: u64,
}

impl ButlerAccount {
    pub(crate) async fn publishing(
        &self,
        request: PublishingRequest,
    ) -> Result<Value, GatewayApplicationError> {
        match request {
            PublishingRequest::Status => Ok(json!({"signed_in": self.read().await?.is_some()})),
            PublishingRequest::Preview { source } => {
                let manifest = self.manifest(source).await?;
                Ok(
                    json!({"signed_in": true, "file_count": manifest.files.len(),
                    "size_bytes": manifest.size_bytes}),
                )
            }
            PublishingRequest::Pages => {
                let stored = self.read().await?.ok_or_else(signed_out)?;
                let response = self
                    .send(Method::GET, "/v1/pages", Some(&stored.device_token), None)
                    .await?;
                let mut value: Value = self
                    .check_publishing(response, 200)
                    .await?
                    .json()
                    .await
                    .map_err(|_| unavailable())?;
                let prefix = format!("{}:", stored.device_id);
                for page in value["pages"].as_array_mut().ok_or_else(unavailable)? {
                    page["item_id"] = json!(
                        page["source_key"]
                            .as_str()
                            .and_then(|key| key.strip_prefix(&prefix))
                    );
                }
                Ok(value)
            }
            PublishingRequest::Unpublish { page_id } => {
                let stored = self.read().await?.ok_or_else(signed_out)?;
                let response = self
                    .send(
                        Method::DELETE,
                        &page_path(&page_id),
                        Some(&stored.device_token),
                        None,
                    )
                    .await?;
                if response.status() != StatusCode::NOT_FOUND {
                    self.check_publishing(response, 204).await?;
                }
                Ok(json!({"unpublished": true}))
            }
            PublishingRequest::Publish {
                item_id,
                title,
                source,
            } => {
                let stored = self.read().await?.ok_or_else(signed_out)?;
                let manifest = self.manifest(source).await?;
                self.publish(&stored, &item_id, &title, manifest).await
            }
        }
    }

    async fn publish(
        &self,
        stored: &StoredAccount,
        item_id: &str,
        title: &str,
        manifest: Manifest,
    ) -> Result<Value, GatewayApplicationError> {
        let title = title.trim();
        let title: String = if title.is_empty() {
            &manifest.entry
        } else {
            title
        }
        .chars()
        .take(200)
        .collect();
        let token = &stored.device_token;
        let response = self
            .send(
                Method::POST,
                "/v1/pages",
                Some(token),
                Some(json!({
                    "source_key": format!("{}:{item_id}", stored.device_id),
                    "title": title, "entry": manifest.entry, "files": manifest.files,
                })),
            )
            .await?;
        let staged: Value = self
            .check_publishing(response, 200)
            .await?
            .json()
            .await
            .map_err(|_| unavailable())?;
        let id = staged["id"].as_str().ok_or_else(unavailable)?;
        let version = staged["version"].as_u64().ok_or_else(unavailable)?;
        let path = page_path(id);
        let content = std::sync::Arc::new(manifest.content);
        for missing in staged["missing"].as_array().ok_or_else(unavailable)? {
            let sha = missing.as_str().ok_or_else(unavailable)?;
            let file = manifest
                .files
                .iter()
                .find(|file| file.sha256 == sha)
                .ok_or_else(unavailable)?;
            let bytes = self.read_file(content.clone(), file.path.clone()).await?;
            let response = self
                .uploads
                .request(Method::PUT, format!("{}{path}/blobs/{sha}", self.base_url))
                .phase(Phase::current().sensitive())
                .bearer_auth(token)
                .header(CONTENT_TYPE, "application/octet-stream")
                .body(bytes)
                .send()
                .await
                .map_err(|_| unavailable())?;
            self.check_publishing(response, 204).await?;
        }

        let response = self
            .send(
                Method::POST,
                &format!("{path}/publish"),
                Some(token),
                Some(json!({"version": version})),
            )
            .await?;
        let published: Value = self
            .check_publishing(response, 200)
            .await?
            .json()
            .await
            .map_err(|_| unavailable())?;
        Ok(json!({"page_id": id,
            "url": published["url"].as_str().ok_or_else(unavailable)?,
            "version": published["version"].as_u64().ok_or_else(unavailable)?,
            "file_count": manifest.files.len(), "size_bytes": manifest.size_bytes}))
    }

    async fn check_publishing(
        &self,
        response: Response,
        expected: u16,
    ) -> Result<Response, GatewayApplicationError> {
        if response.status() == StatusCode::UNAUTHORIZED {
            self.delete().await?;
            return Err(signed_out());
        }
        check(response, expected).await
    }

    async fn manifest(&self, source: PublishSource) -> Result<Manifest, GatewayApplicationError> {
        let data = self.data.clone();
        tokio::task::spawn_blocking(move || {
            let (content, entry, files) = match source {
                PublishSource::Output { output_id } => {
                    let store = OutputStore::new(&data);
                    let output = store.read(&output_id).map_err(source_error)?;
                    let rev = output
                        .revisions
                        .into_iter()
                        .max_by_key(|rev| rev.revision)
                        .ok_or_else(not_publishable)?;
                    let files = rev
                        .files
                        .into_iter()
                        .map(|(path, sha256)| {
                            let size = store
                                .open_content(&output_id, rev.revision, &path)?
                                .metadata()?
                                .len();
                            Ok(ManifestFile { path, sha256, size })
                        })
                        .collect::<io::Result<Vec<_>>>()
                        .map_err(source_error)?;
                    (
                        Content::Output {
                            output_id,
                            revision: rev.revision,
                        },
                        rev.entry,
                        files,
                    )
                }
                PublishSource::File { file_id, name } => {
                    let path = message_file_path(&data, &file_id).ok_or_else(not_publishable)?;
                    let mut file = File::open(&path).map_err(source_error)?;
                    let size = file.metadata().map_err(source_error)?.len();
                    let mut hash = Sha256::new();
                    io::copy(&mut file, &mut hash).map_err(source_error)?;
                    let files = vec![ManifestFile {
                        path: name.clone(),
                        sha256: format!("{:x}", hash.finalize()),
                        size,
                    }];
                    (Content::File(path), name, files)
                }
            };
            let size_bytes = files.iter().map(|file| file.size).sum();
            Ok(Manifest {
                content,
                entry,
                files,
                size_bytes,
            })
        })
        .await
        .map_err(GatewayApplicationError::internal_from)?
    }

    async fn read_file(
        &self,
        source: std::sync::Arc<Content>,
        path: String,
    ) -> Result<Vec<u8>, GatewayApplicationError> {
        let store = OutputStore::new(&self.data);
        tokio::task::spawn_blocking(move || match source.as_ref() {
            Content::Output {
                output_id,
                revision,
            } => {
                let mut bytes = Vec::new();
                store
                    .open_content(output_id, *revision, &path)?
                    .read_to_end(&mut bytes)?;
                Ok(bytes)
            }
            Content::File(file) => std::fs::read(file),
        })
        .await
        .map_err(GatewayApplicationError::internal_from)?
        .map_err(source_error)
    }
}

fn page_path(id: &str) -> String {
    let encoded: String = url::form_urlencoded::byte_serialize(id.as_bytes()).collect();
    format!("/v1/pages/{}", encoded.replace('+', "%20"))
}

fn source_error(error: io::Error) -> GatewayApplicationError {
    if error.kind() == io::ErrorKind::NotFound {
        not_publishable()
    } else {
        GatewayApplicationError::internal_from(error)
    }
}

fn not_publishable() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 404,
        code: "not_publishable".into(),
        message: "This item can't be published.".into(),
        source: None,
    }
}
