//! Web access wired for tests: direct page fetches against local servers.

use std::path::PathBuf;
use std::sync::Arc;

use super::WebAccess;
use super::service::{DirectPageRoute, PageRoute};

/// Web access with planning disabled and pages fetched directly.
/// The search endpoint (a local fixture) is the only loopback address reached.
pub fn access(data_root: PathBuf, search_endpoint: &str) -> WebAccess {
    configured(
        data_root,
        search_endpoint,
        None,
        Arc::new(DirectPageRoute),
        &[search_endpoint],
    )
}

/// Web access with an optional planner prompt and page route. `fixtures`
/// names the loopback servers the test runs: the egress guard's documented
/// test exception (`LoopbackFixtures`); every other private address is refused.
pub(crate) fn configured(
    data_root: PathBuf,
    search_endpoint: &str,
    prompt: Option<Arc<dyn butler_models::models::ProviderPromptPort>>,
    route: Arc<dyn PageRoute>,
    fixtures: &[&str],
) -> WebAccess {
    let metrics = Arc::new(crate::operations::WebSearchMetrics::new(data_root.clone()));
    let planning_disabled = prompt.is_none();
    WebAccess::configured(
        data_root,
        search_endpoint,
        None,
        prompt,
        metrics,
        planning_disabled,
        (route, crate::browser::LoopbackFixtures::serving(fixtures)),
    )
    .expect("test web access")
}
