use std::{collections::HashSet, sync::Arc, time::Duration};

use butler_log::http::{Client, Phase, Purpose, RedirectPolicy};
use reqwest::{Method, Response, header};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{Account, Error, Result, error};

#[derive(Clone)]
pub(super) struct Cloud {
    http: Client,
    account: Arc<Account>,
}

#[derive(Clone)]
pub(super) struct Session {
    cloud: Cloud,
    token: String,
}

#[derive(Deserialize)]
pub(super) struct Inventory {
    pub used_bytes: u64,
    pub quota_bytes: u64,
    pub snapshots: Vec<Snapshot>,
}

#[derive(Deserialize)]
pub(super) struct Snapshot {
    pub slot: u8,
    pub version: u64,
    pub created_at: String,
}

impl Cloud {
    pub(super) fn new(account: Arc<Account>) -> Result<Self> {
        let http = butler_log::http::external(Purpose::new("butler-backup"))
            .timeout(Duration::from_secs(60))
            .redirect(RedirectPolicy::none())
            .build()
            .map_err(|_| unavailable())?;
        Ok(Self { http, account })
    }

    pub(super) async fn session(&self) -> Result<Session> {
        let token = self.account.device_token().await?.ok_or_else(signed_out)?;
        Ok(Session {
            cloud: self.clone(),
            token,
        })
    }
}

impl Session {
    async fn request(
        &self,
        method: Method,
        path: &str,
        json: Option<Value>,
        bytes: Option<Vec<u8>>,
        version: Option<u64>,
    ) -> Result<Response> {
        let mut request = self
            .cloud
            .http
            .request(
                method,
                format!("{}/v1/backup{path}", self.cloud.account.base_url()),
            )
            .phase(Phase::current().sensitive())
            .bearer_auth(&self.token);
        if let Some(json) = json {
            request = request.json(&json);
        }
        if let Some(bytes) = bytes {
            request = request
                .header(header::CONTENT_LENGTH, bytes.len())
                .body(bytes);
        }
        if let Some(version) = version {
            request = request.header(header::IF_MATCH, format!("\"{version}\""));
        }
        let response = request.send().await.map_err(|_| unavailable())?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        if status.as_u16() == 401 {
            self.cloud.account.delete().await?;
            return Err(signed_out());
        }
        let body: Value = response.json().await.unwrap_or(Value::Null);
        Err(error(
            status.as_u16(),
            body["error"]["code"].as_str().unwrap_or("cloud_error"),
            body["error"]["message"]
                .as_str()
                .unwrap_or("The Butler service did not answer as expected."),
        ))
    }

    pub(super) async fn inventory(&self) -> Result<Inventory> {
        self.request(Method::GET, "", None, None, None)
            .await?
            .json()
            .await
            .map_err(|_| unavailable())
    }

    /// The ids the server does not hold, asked in groups of up to 1000.
    pub(super) async fn missing(&self, ids: &[String]) -> Result<HashSet<String>> {
        #[derive(Deserialize)]
        struct Missing {
            missing: Vec<String>,
        }
        let mut missing = HashSet::new();
        for group in ids.chunks(1000) {
            let body: Missing = self
                .request(
                    Method::POST,
                    "/chunks/missing",
                    Some(json!({"ids": group})),
                    None,
                    None,
                )
                .await?
                .json()
                .await
                .map_err(|_| unavailable())?;
            missing.extend(body.missing);
        }
        Ok(missing)
    }

    pub(super) async fn push_chunk(&self, id: &str, bytes: Vec<u8>) -> Result<()> {
        self.request(
            Method::PUT,
            &format!("/chunks/{id}"),
            None,
            Some(bytes),
            None,
        )
        .await?;
        Ok(())
    }

    pub(super) async fn pull_chunk(&self, id: &str) -> Result<Vec<u8>> {
        let mut response = self
            .request(Method::GET, &format!("/chunks/{id}"), None, None, None)
            .await?;
        let mut bytes = Vec::new();
        while let Some(part) = response.chunk().await.map_err(|_| unavailable())? {
            if part.len() > (butler_backup::backup::PIECE + 32) - bytes.len() {
                return Err(error(400, "chunk_corrupt", "The backup chunk is invalid."));
            }
            bytes.extend_from_slice(&part);
        }
        Ok(bytes)
    }

    pub(super) async fn pull_snapshot(&self, snapshot: &Snapshot) -> Result<Vec<u8>> {
        let mut response = self
            .request(
                Method::GET,
                &format!("/snapshots/{}", snapshot.slot),
                None,
                None,
                None,
            )
            .await?;
        let version = format!("\"{}\"", snapshot.version);
        if response
            .headers()
            .get(header::ETAG)
            .and_then(|value| value.to_str().ok())
            != Some(version.as_str())
        {
            return Err(error(409, "version_conflict", "The backup changed."));
        }
        let hash = response.headers().get("x-content-sha256").cloned();
        let mut bytes = Vec::new();
        while let Some(part) = response.chunk().await.map_err(|_| unavailable())? {
            if part.len() > 8 * 1024 * 1024 - bytes.len() {
                return Err(error(
                    400,
                    "manifest_invalid",
                    "The backup manifest is invalid.",
                ));
            }
            bytes.extend_from_slice(&part);
        }
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if hash.as_ref().and_then(|hash| hash.to_str().ok()) != Some(actual.as_str()) {
            return Err(error(
                400,
                "manifest_invalid",
                "The backup manifest is invalid.",
            ));
        }
        Ok(bytes)
    }

    pub(super) async fn push_snapshot(
        &self,
        slot: u8,
        version: u64,
        bytes: Vec<u8>,
    ) -> Result<u64> {
        #[derive(Deserialize)]
        struct Version {
            version: u64,
        }
        let body: Version = self
            .request(
                Method::PUT,
                &format!("/snapshots/{slot}"),
                None,
                Some(bytes),
                Some(version),
            )
            .await?
            .json()
            .await
            .map_err(|_| unavailable())?;
        Ok(body.version)
    }

    pub(super) async fn delete_chunks(&self, ids: &[String]) -> Result<()> {
        for group in ids.chunks(1000) {
            self.request(
                Method::POST,
                "/chunks/delete",
                Some(json!({"ids": group})),
                None,
                None,
            )
            .await?;
        }
        Ok(())
    }

    pub(super) async fn delete_all(&self) -> Result<()> {
        #[derive(Deserialize)]
        struct Deletion {
            done: bool,
        }
        loop {
            let body: Deletion = self
                .request(Method::DELETE, "", None, None, None)
                .await?
                .json()
                .await
                .map_err(|_| unavailable())?;
            if body.done {
                return Ok(());
            }
        }
    }
}

fn unavailable() -> Error {
    error(
        502,
        "cloud_unavailable",
        "The Butler service could not be reached.",
    )
}

pub(super) fn signed_out() -> Error {
    error(
        401,
        "butler_account_signed_out",
        "Sign in to your Butler account first.",
    )
}
