//! Settings → Security calls (#229) as the App and the CLI make them: from
//! this computer, with the gateway token and the local admin credential in
//! `X-Butler-Admin`.

use reqwest::Method;
use serde_json::{Value, json};

use super::agent::ADMIN_HEADER;
use super::gateway::{Gateway, Reply};
use super::{HarnessError, harness_error};

/// A gateway client that also holds the local admin credential.
#[derive(Clone)]
pub struct AdminClient {
    pub gw: Gateway,
    pub admin: String,
}

impl AdminClient {
    pub fn new(gw: Gateway, admin: String) -> Self {
        Self { gw, admin }
    }

    /// `method path` with the token and the admin credential, plus `extra`
    /// headers.
    pub async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        extra: &[(&str, &str)],
    ) -> Result<Reply, HarnessError> {
        let mut headers = vec![(ADMIN_HEADER, self.admin.as_str())];
        headers.extend_from_slice(extra);
        self.gw
            .send_with(
                method,
                path,
                body.map(|body| body.to_string()),
                Some(&self.gw.token),
                &headers,
            )
            .await
    }

    /// `GET /security` (must answer 200).
    pub async fn view(&self) -> Result<Value, HarnessError> {
        let reply = self.send(Method::GET, "/security", None, &[]).await?;
        ok(&reply, "GET /security")
    }

    /// `PATCH /settings {security: {remote_access_enabled}}`, then the view.
    pub async fn set_remote(&self, enabled: bool) -> Result<Value, HarnessError> {
        let body = json!({"security": {"remote_access_enabled": enabled}});
        let reply = self
            .send(Method::PATCH, "/settings", Some(body), &[])
            .await?;
        let settings = ok(&reply, "PATCH /settings security")?;
        if settings["security"]["remote_access_enabled"] != enabled {
            return Err(harness_error(format!("remote access not set: {settings}")));
        }
        self.view().await
    }

    /// `POST /security/connection-code/rotate`: the new code.
    pub async fn rotate(&self) -> Result<Value, HarnessError> {
        let reply = self
            .send(Method::POST, "/security/connection-code/rotate", None, &[])
            .await?;
        ok(&reply, "rotate")
    }
}

/// Every security route, each with a request that would change something.
pub fn security_calls() -> [(Method, &'static str, Option<Value>); 8] {
    [
        (Method::GET, "/security", None),
        (Method::POST, "/security/pairing", None),
        (Method::GET, "/security/pairing", None),
        (Method::GET, "/security/devices", None),
        (Method::DELETE, "/security/devices", None),
        (
            Method::DELETE,
            "/security/devices/00000000-0000-0000-0000-000000000000",
            None,
        ),
        (Method::POST, "/security/connection-code/rotate", None),
        (
            Method::PATCH,
            "/settings",
            Some(json!({"security": {"remote_access_enabled": true}})),
        ),
    ]
}

fn ok(reply: &Reply, what: &str) -> Result<Value, HarnessError> {
    if reply.status == 200 {
        Ok(reply.data().clone())
    } else {
        Err(harness_error(format!(
            "{what} answered {}: {}",
            reply.status, reply.text
        )))
    }
}
