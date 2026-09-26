use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use reqwest::{Client, Url, redirect::Policy};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::{providers, spool::TemporarySpool};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const SEARCH_ENDPOINT: &str = "https://html.duckduckgo.com/html/";

mod fetch;
mod session;

#[derive(Clone)]
pub(crate) struct WebAccess {
    inner: Arc<WebAccessInner>,
}

struct WebAccessInner {
    data_root: PathBuf,
    client: Client,
    search_endpoint: Url,
    configuration: Option<Arc<crate::models::ModelConfiguration>>,
    prompt: Option<Arc<dyn crate::models::ProviderPromptPort>>,
    metrics: Arc<crate::operations::WebSearchMetrics>,
    test_planning_disabled: bool,
    #[cfg(test)]
    page_test_endpoint: Option<Url>,
    #[cfg(test)]
    lightpanda_test_binary: Option<PathBuf>,
}

#[derive(Clone)]
pub(crate) struct WebSession {
    pub(super) access: WebAccess,
    state: Arc<Mutex<WebSessionState>>,
    planning_gate: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Default)]
struct WebSessionState {
    first_search_consumed: bool,
    original_request: String,
    page_cache: HashMap<String, TemporarySpool>,
    observation_cache: HashMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WebAccessError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl WebAccessError {
    pub(super) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(super) fn cancelled() -> Self {
        Self::new("cancelled", "Public web retrieval was cancelled.")
    }
}

impl WebAccess {
    #[cfg(test)]
    pub(crate) fn for_test_with_prompt(
        data_root: PathBuf,
        endpoint: &str,
        prompt: Arc<dyn crate::models::ProviderPromptPort>,
    ) -> Self {
        let metrics = Arc::new(crate::operations::WebSearchMetrics::new(data_root.clone()));
        Self::with_endpoint(data_root, endpoint, None, Some(prompt), metrics, false)
            .expect("test web access with planner")
    }

    #[cfg(test)]
    pub(crate) fn for_test_with_page_endpoint(
        data_root: PathBuf,
        search_endpoint: &str,
        page_endpoint: &str,
    ) -> Self {
        let mut access = Self::for_test(data_root, search_endpoint);
        let endpoint = Url::parse(page_endpoint).expect("test page endpoint is a URL");
        Arc::get_mut(&mut access.inner)
            .expect("test web access is uniquely owned")
            .page_test_endpoint = Some(endpoint);
        access
    }

    #[cfg(test)]
    pub(crate) fn for_test_with_page_endpoint_and_lightpanda(
        data_root: PathBuf,
        search_endpoint: &str,
        page_endpoint: &str,
        binary: PathBuf,
    ) -> Self {
        let mut access =
            Self::for_test_with_page_endpoint(data_root, search_endpoint, page_endpoint);
        Arc::get_mut(&mut access.inner)
            .expect("test web access is uniquely owned")
            .lightpanda_test_binary = Some(binary);
        access
    }

    pub(crate) fn new(
        data_root: PathBuf,
        configuration: Arc<crate::models::ModelConfiguration>,
        prompt: Arc<dyn crate::models::ProviderPromptPort>,
        metrics: Arc<crate::operations::WebSearchMetrics>,
    ) -> Result<Self, WebAccessError> {
        Self::with_endpoint(
            data_root,
            SEARCH_ENDPOINT,
            Some(configuration),
            Some(prompt),
            metrics,
            false,
        )
    }

    /// Reader and search-status commands need no Models provider or runtime.
    pub(crate) fn new_reader(
        data_root: PathBuf,
        metrics: Arc<crate::operations::WebSearchMetrics>,
    ) -> Result<Self, WebAccessError> {
        Self::with_endpoint(data_root, SEARCH_ENDPOINT, None, None, metrics, false)
    }

    /// Search-test commands compose provider auth without a prompt planner.
    pub(crate) fn new_search(
        data_root: PathBuf,
        configuration: Arc<crate::models::ModelConfiguration>,
        metrics: Arc<crate::operations::WebSearchMetrics>,
    ) -> Result<Self, WebAccessError> {
        Self::with_endpoint(
            data_root,
            SEARCH_ENDPOINT,
            Some(configuration),
            None,
            metrics,
            true,
        )
    }

    fn with_endpoint(
        data_root: PathBuf,
        endpoint: &str,
        configuration: Option<Arc<crate::models::ModelConfiguration>>,
        prompt: Option<Arc<dyn crate::models::ProviderPromptPort>>,
        metrics: Arc<crate::operations::WebSearchMetrics>,
        test_planning_disabled: bool,
    ) -> Result<Self, WebAccessError> {
        let search_endpoint = Url::parse(endpoint).map_err(|_| {
            WebAccessError::new(
                "web_access_configuration_invalid",
                "Search endpoint is invalid.",
            )
        })?;
        let client = Client::builder()
            .redirect(Policy::custom(|attempt| {
                if attempt.previous().len() >= 10 {
                    return attempt.error("too many redirects");
                }
                if !attempt.url().username().is_empty() || attempt.url().password().is_some() {
                    return attempt.stop();
                }
                attempt.follow()
            }))
            .timeout(REQUEST_TIMEOUT)
            .user_agent("butler-native-web-access/0.1")
            .build()
            .map_err(|_| {
                WebAccessError::new(
                    "web_access_unavailable",
                    "Public web client is unavailable.",
                )
            })?;
        Ok(Self {
            inner: Arc::new(WebAccessInner {
                data_root,
                client,
                search_endpoint,
                configuration,
                prompt,
                metrics,
                test_planning_disabled,
                #[cfg(test)]
                page_test_endpoint: None,
                #[cfg(test)]
                lightpanda_test_binary: None,
            }),
        })
    }

    pub(crate) fn session_for_turn(&self, original_request: String) -> WebSession {
        WebSession {
            access: self.clone(),
            state: Arc::new(Mutex::new(WebSessionState {
                original_request,
                ..WebSessionState::default()
            })),
            planning_gate: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    pub(super) fn config(&self) -> Result<Value, WebAccessError> {
        crate::configuration::read_json_object(&self.inner.data_root.join("butler.config.json"))
            .map_err(|_| {
                WebAccessError::new(
                    "web_access_configuration_invalid",
                    "Butler web configuration could not be read.",
                )
            })
    }

    pub(super) fn private_environment(&self) -> Result<HashMap<String, String>, WebAccessError> {
        crate::configuration::read_private_environment(&self.inner.data_root.join(".env")).map_err(
            |_| {
                WebAccessError::new(
                    "web_access_configuration_invalid",
                    "Private web settings could not be read.",
                )
            },
        )
    }

    pub(super) fn environment_value(&self, name: &str) -> Result<Option<String>, WebAccessError> {
        if let Some(value) = nonempty_env(name) {
            return Ok(Some(value));
        }
        Ok(self
            .private_environment()?
            .get(name)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty()))
    }

    pub(super) fn configuration(&self) -> Option<&Arc<crate::models::ModelConfiguration>> {
        self.inner.configuration.as_ref()
    }

    pub(super) fn prompt(&self) -> Option<&Arc<dyn crate::models::ProviderPromptPort>> {
        self.inner.prompt.as_ref()
    }

    pub(super) fn metrics(&self) -> &crate::operations::WebSearchMetrics {
        self.inner.metrics.as_ref()
    }

    pub(super) fn test_planning_disabled(&self) -> bool {
        self.inner.test_planning_disabled
    }

    pub(super) fn client(&self) -> &Client {
        &self.inner.client
    }

    pub(super) fn data_root(&self) -> &std::path::Path {
        &self.inner.data_root
    }

    #[cfg(test)]
    pub(super) fn lightpanda_test_binary(&self) -> Option<&std::path::Path> {
        self.inner.lightpanda_test_binary.as_deref()
    }

    pub(super) fn configured_provider(&self) -> Result<String, WebAccessError> {
        if let Some(value) = self.environment_value("BUTLER_WEB_SEARCH_PROVIDER")? {
            return Ok(value);
        }
        let config = self.config()?;
        Ok(config["webSearch"]["provider"]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("duckduckgo-html")
            .to_owned())
    }

    pub(super) fn configured_reader(
        &self,
        explicit: Option<&str>,
    ) -> Result<String, WebAccessError> {
        if let Some(value) = explicit {
            return Ok(normalize_reader_backend(value));
        }
        if let Some(value) = self.environment_value("BUTLER_WEB_READER_BACKEND")? {
            return Ok(normalize_reader_backend(&value));
        }
        let config = self.config()?;
        Ok(normalize_reader_backend(
            config["webSearch"]["readerBackend"]
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("lightweight"),
        ))
    }

    pub(crate) fn search_status(&self) -> Result<Value, WebAccessError> {
        providers::status(self)
    }

    pub(crate) async fn search_test(
        &self,
        query: &str,
        cancellation: &CancellationToken,
    ) -> Result<Value, WebAccessError> {
        providers::test_search(self, query, cancellation).await
    }

    pub(super) fn search_url(&self, query: &str) -> Url {
        let mut url = self.inner.search_endpoint.clone();
        url.query_pairs_mut().append_pair("q", query);
        url
    }
}

fn nonempty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
impl WebAccess {
    pub(crate) fn for_test(data_root: PathBuf, endpoint: &str) -> Self {
        let metrics = Arc::new(crate::operations::WebSearchMetrics::new(data_root.clone()));
        Self::with_endpoint(data_root, endpoint, None, None, metrics, true)
            .expect("test web access")
    }
}

fn normalize_reader_backend(value: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "auto" | "lightpanda" | "lightweight" | "jina-hosted" | "disabled" => normalized,
        _ => "lightweight".into(),
    }
}

#[cfg(test)]
fn test_page_url(base: &Url, logical: &Url) -> Url {
    let mut url = base.clone();
    url.set_path(&format!(
        "/{}{}",
        logical.host_str().unwrap_or_default(),
        logical.path()
    ));
    url.set_query(logical.query());
    url
}
