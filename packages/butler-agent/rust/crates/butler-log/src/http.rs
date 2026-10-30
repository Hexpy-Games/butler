//! The outbound HTTP boundary. Clients never expose an unlogged send path.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the sole reqwest construction and execution boundary"
)]
mod client;
mod connection;
pub use connection::{Connection, ConnectionStream};
mod error;
mod execute;
mod logging;
pub use logging::{initialize_with, shutdown};
mod redirect;
pub use redirect::{
    Action as RedirectAction, Attempt as RedirectAttempt, Policy as RedirectPolicy,
};
mod upload;
pub use error::Error;
mod body;
mod capture;
#[cfg(feature = "e2e-fixtures")]
pub mod fixtures;
mod observe;
mod request;
mod response;
mod retry;
mod sse;
pub use client::{Client, ClientBuilder};
pub use request::RequestBuilder;

#[derive(Clone, Debug)]
pub struct Purpose {
    name: String,
    category: String,
}
impl Purpose {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.into(),
            category: "http.client".into(),
        }
    }
    pub fn provider(provider: &str, name: &str) -> Self {
        Self {
            name: name.into(),
            category: format!("provider.{provider}"),
        }
    }
}
#[derive(Clone, Debug, Default)]
pub struct Phase {
    name: String,
    retry: u32,
    routine: bool,
    sensitive: bool,
    origin_only: bool,
    trace_id: Option<String>,
    turn_id: Option<String>,
    chat_id: Option<String>,
}
impl Phase {
    pub fn current() -> Self {
        let mut row = crate::Record::new("DEBUG", "http.client", "", "");
        crate::structured_logging::current_ids(&mut row);
        Self {
            trace_id: row.trace_id,
            turn_id: row.turn_id,
            chat_id: row.chat_id,
            ..Self::default()
        }
    }
    /// Routine background attempts remain DEBUG, including fallback and HTTP rejection.
    pub fn routine(mut self) -> Self {
        self.routine = true;
        self
    }
    /// Never capture request or response bodies; status, headers, sizes and timings are still logged.
    pub fn sensitive(mut self) -> Self {
        self.sensitive = true;
        self
    }
    /// Log only the scheme and host: for URLs whose path or query is itself a
    /// credential (webhooks, for example), whatever shape it has.
    pub fn origin_only(mut self) -> Self {
        self.origin_only = true;
        self
    }
    /// A transport error's text; never the URL of an origin-only request.
    fn error_text(&self, error: &reqwest::Error) -> String {
        let text = error.to_string();
        match error.url().filter(|_| self.origin_only) {
            Some(url) => text.replace(url.as_str(), "[REDACTED]"),
            None => text,
        }
    }
    pub fn trace_id(&self) -> Option<&str> {
        self.trace_id.as_deref()
    }
    pub fn turn_id(&self) -> Option<&str> {
        self.turn_id.as_deref()
    }
    pub fn chat_id(&self) -> Option<&str> {
        self.chat_id.as_deref()
    }
    pub fn new(name: &str, retry: u32) -> Self {
        Self {
            name: name.into(),
            retry,
            ..Self::default()
        }
    }
    pub fn ids(mut self, trace: Option<&str>, turn: Option<&str>, chat: Option<&str>) -> Self {
        self.trace_id = trace.map(str::to_owned);
        self.turn_id = turn.map(str::to_owned);
        self.chat_id = chat.map(str::to_owned);
        self
    }
}
/// Configure an external client, retaining its transport/security options.
pub fn external(purpose: Purpose) -> ClientBuilder {
    ClientBuilder::new(purpose)
}
/// Only Butler-to-Butler traffic uses this category (local models are external).
pub fn loopback() -> ClientBuilder {
    ClientBuilder::new(Purpose {
        name: "butler".into(),
        category: "http.local".into(),
    })
}

/// Execute one attempt and every permitted redirect through the same boundary.
pub async fn send(
    request: RequestBuilder,
    purpose: Purpose,
    phase: Phase,
) -> Result<reqwest::Response, Error> {
    let (client, built) = request.inner.build_split();
    execute::chain(
        client,
        built?,
        request.redirect,
        purpose,
        phase,
        request.timeout,
    )
    .await
}

fn register_credentials(request: &reqwest::Request) {
    for (name, value) in request.headers() {
        if matches!(
            name.as_str(),
            "authorization"
                | "proxy-authorization"
                | "x-api-key"
                | "x-goog-api-key"
                | "cookie"
                | "set-cookie"
        ) && let Ok(value) = value.to_str()
        {
            crate::register_secret_for(
                &format!("{}:{name}", request.url().origin().ascii_serialization()),
                value.strip_prefix("Bearer ").unwrap_or(value),
            );
        }
    }
    if request.headers().get("content-type").is_some_and(|v| {
        v.as_bytes()
            .starts_with(b"application/x-www-form-urlencoded")
    }) && let Some(body) = request.body().and_then(reqwest::Body::as_bytes)
    {
        for (key, value) in url::form_urlencoded::parse(body) {
            if matches!(
                key.as_ref(),
                "code" | "code_verifier" | "access_token" | "refresh_token" | "client_secret"
            ) {
                crate::register_secret_for(
                    &format!("{}:{key}", request.url().origin().ascii_serialization()),
                    &value,
                );
            }
        }
    }
}
