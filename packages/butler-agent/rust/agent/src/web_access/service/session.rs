use std::sync::Arc;

use serde_json::Value;

use super::{WebAccessError, WebSession};
use crate::web_access::{page::PageRead, spool::TemporarySpool};

const MAX_OBSERVATION_CACHE_ENTRIES: usize = 16;

impl WebSession {
    pub(crate) fn configured_disabled_reason(
        &self,
        tool_name: &str,
    ) -> Option<(&'static str, &'static str)> {
        if tool_name == "web_search"
            && self.access.configured_provider().ok().as_deref() == Some("disabled")
        {
            return Some((
                "Public web search is disabled by configuration.",
                "Enable a public web search provider in Butler settings before selecting this tool.",
            ));
        }
        None
    }

    pub(in crate::web_access) fn first_search_consumed(&self) -> bool {
        self.state
            .lock()
            .expect("web session poisoned")
            .first_search_consumed
    }

    pub(in crate::web_access) fn original_request(&self) -> String {
        self.state
            .lock()
            .expect("web session poisoned")
            .original_request
            .clone()
    }

    pub(in crate::web_access) fn mark_planner_ran(&self) {
        self.state
            .lock()
            .expect("web session poisoned")
            .first_search_consumed = true;
    }

    pub(in crate::web_access) async fn lock_planning(&self) -> tokio::sync::OwnedMutexGuard<()> {
        Arc::clone(&self.planning_gate).lock_owned().await
    }

    pub(in crate::web_access) async fn cached_page(
        &self,
        key: &str,
    ) -> Result<Option<PageRead>, WebAccessError> {
        let path = self
            .state
            .lock()
            .expect("web session poisoned")
            .page_cache
            .get(key)
            .map(|spool| spool.path.clone());
        let Some(path) = path else {
            return Ok(None);
        };
        let bytes = tokio::fs::read(path).await.map_err(|_| {
            WebAccessError::new(
                "web_access_cache_failed",
                "Turn web cache could not be read.",
            )
        })?;
        serde_json::from_slice(&bytes).map(Some).map_err(|_| {
            WebAccessError::new(
                "web_access_cache_failed",
                "Turn web cache could not be decoded.",
            )
        })
    }

    pub(in crate::web_access) async fn remember_page(
        &self,
        key: String,
        result: &PageRead,
    ) -> Result<(), WebAccessError> {
        let root = self.access.inner.data_root.clone();
        let bytes = serde_json::to_vec(result).map_err(|_| {
            WebAccessError::new(
                "web_access_cache_failed",
                "Turn web cache could not be encoded.",
            )
        })?;
        let spool = tokio::task::spawn_blocking(move || TemporarySpool::from_bytes(&root, &bytes))
            .await
            .map_err(|_| {
                WebAccessError::new(
                    "web_access_cache_failed",
                    "Turn web cache could not be written.",
                )
            })?
            .map_err(|_| {
                WebAccessError::new(
                    "web_access_cache_failed",
                    "Turn web cache could not be written.",
                )
            })?;
        self.state
            .lock()
            .expect("web session poisoned")
            .page_cache
            .insert(key, spool);
        Ok(())
    }

    pub(in crate::web_access) fn cached_observation(&self, key: &str) -> Option<Value> {
        self.state
            .lock()
            .expect("web session poisoned")
            .observation_cache
            .get(key)
            .cloned()
    }

    pub(in crate::web_access) fn remember_observation(&self, key: String, value: Value) {
        let mut state = self.state.lock().expect("web session poisoned");
        if !state.observation_cache.contains_key(&key)
            && state.observation_cache.len() >= MAX_OBSERVATION_CACHE_ENTRIES
        {
            state.observation_cache.clear();
        }
        state.observation_cache.insert(key, value);
    }
}
