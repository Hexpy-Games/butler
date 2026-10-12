//! Turn-scoped links between search results, browser tabs and page reads:
//! the ids the model opens results by, the tabs pages are open in, and one
//! in-flight read per page so a URL is read once per turn.
use std::{collections::HashMap, sync::Arc};

use super::WebSession;

#[derive(Default)]
pub(super) struct Registry {
    results: Vec<SearchResultRef>,
    by_url: HashMap<String, usize>,
    opened: HashMap<String, Opened>,
    reads: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
}

/// One search result as `browser_open` opens it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchResultRef {
    pub id: String,
    pub url: String,
    pub title: String,
}

/// An agent tab's document as the page shows it now, read for `web_read`.
pub struct LivePage {
    pub tab: String,
    pub epoch: u64,
    pub final_url: String,
    pub html: String,
}

struct Opened {
    tab: String,
    landed: String,
}

/// The document a URL names: a fragment never changes what is read.
pub(crate) fn page_key(url: &str) -> String {
    match url::Url::parse(url.trim()) {
        Ok(mut parsed) => {
            parsed.set_fragment(None);
            parsed.to_string()
        }
        Err(_) => url.trim().to_owned(),
    }
}

/// The turn cache key of a tab's page while the tab stays at `epoch`.
pub(crate) fn tab_key(tab: &str, epoch: u64, url: &str) -> String {
    format!("tab:{tab}:{epoch}:{}", page_key(url))
}

impl WebSession {
    /// Whether this turn already read `tab` at `epoch` showing `url`, so its
    /// document need not be read again.
    pub fn has_tab_page(&self, tab: &str, epoch: u64, url: &str) -> bool {
        self.state
            .lock()
            .page_cache
            .contains_key(&tab_key(tab, epoch, url))
    }

    /// `r<n>` ids for `(url, title)` results; a URL keeps its id all turn.
    pub(in crate::web_access) fn result_ids(&self, results: &[(String, String)]) -> Vec<String> {
        let mut state = self.state.lock();
        let registry = &mut state.registry;
        results
            .iter()
            .map(|(url, title)| {
                let key = page_key(url);
                if let Some(index) = registry.by_url.get(&key) {
                    return registry.results[*index].id.clone();
                }
                let id = format!("r{}", registry.results.len() + 1);
                registry.results.push(SearchResultRef {
                    id: id.clone(),
                    url: url.clone(),
                    title: title.clone(),
                });
                registry.by_url.insert(key, registry.results.len() - 1);
                id
            })
            .collect()
    }

    /// The search result of this turn with `id`.
    pub fn search_result(&self, id: &str) -> Option<SearchResultRef> {
        let state = self.state.lock();
        state
            .registry
            .results
            .iter()
            .find(|result| result.id == id.trim())
            .cloned()
    }

    /// `requested` opened in `tab`, which landed on `landed`.
    pub fn remember_tab(&self, requested: &str, tab: &str, landed: &str) {
        let opened = Opened {
            tab: tab.to_owned(),
            landed: page_key(landed),
        };
        self.state
            .lock()
            .registry
            .opened
            .insert(page_key(requested), opened);
    }

    /// The tab showing `url` among `tabs` (id, current URL): a tab on that
    /// page, or the tab `url` opened in while it still shows where it landed.
    pub fn open_tab_for(&self, url: &str, tabs: &[(String, String)]) -> Option<String> {
        let key = page_key(url);
        if let Some((tab, _)) = tabs.iter().find(|(_, current)| page_key(current) == key) {
            return Some(tab.clone());
        }
        let state = self.state.lock();
        let opened = state.registry.opened.get(&key)?;
        tabs.iter()
            .find(|(tab, current)| *tab == opened.tab && page_key(current) == opened.landed)
            .map(|(tab, _)| tab.clone())
    }

    /// The gate one read of `key` holds, so a parallel read of the same page
    /// waits for the first and reuses it.
    pub(in crate::web_access) fn read_gate(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.state
            .lock()
            .registry
            .reads
            .entry(key.to_owned())
            .or_default()
            .clone()
    }
}
