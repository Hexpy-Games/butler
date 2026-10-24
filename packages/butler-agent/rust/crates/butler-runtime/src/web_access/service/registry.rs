//! Turn-scoped links between search results, browser tabs and page reads:
//! the ids the model opens results by, the tabs pages are open in, the URLs
//! the turn found, and one in-flight read per page so a URL is read once per
//! turn. All but the in-flight reads survive an approval suspension.
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use serde_json::{Value, json};

use super::WebSession;

/// Found URLs kept beyond search results (the user's message, pages read or opened).
const MAX_DISCOVERED: usize = 512;

#[derive(Default)]
pub(super) struct Registry {
    results: Vec<SearchResultRef>,
    by_url: HashMap<String, usize>,
    opened: HashMap<String, Opened>,
    reads: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
    /// Exact URLs (fragment kept) the turn found outside its search results.
    discovered: HashSet<String>,
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

/// A URL as provenance compares it: normalized with its fragment kept, since
/// a page script can read the fragment.
fn exact_key(url: &str) -> String {
    url::Url::parse(url.trim()).map_or_else(|_| url.trim().to_owned(), |parsed| parsed.to_string())
}

/// The turn cache key of a tab's page while the tab stays at `epoch`.
pub(crate) fn tab_key(tab: &str, epoch: u64, url: &str) -> String {
    format!("tab:{tab}:{epoch}:{}", page_key(url))
}

impl WebSession {
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

    /// Records `url` as found by this turn (in the user's message, or a page
    /// it read or opened): requesting it again sends nothing new.
    pub fn discover(&self, url: &str) {
        let key = exact_key(url);
        let mut state = self.state.lock();
        let registry = &mut state.registry;
        if registry.discovered.len() < MAX_DISCOVERED && !registry.is_result(&key) {
            registry.discovered.insert(key);
        }
    }

    /// Whether this turn found `url` itself: a search result, a URL in the
    /// user's message, or a page it already read or opened.
    pub fn discovered(&self, url: &str) -> bool {
        let key = exact_key(url);
        let state = self.state.lock();
        state.registry.discovered.contains(&key) || state.registry.is_result(&key)
    }

    /// The result ids, found URLs, opened tabs and planner state this turn
    /// carries across an approval suspension; `None` before any web use.
    pub fn snapshot(&self) -> Option<Value> {
        let state = self.state.lock();
        let registry = &state.registry;
        if registry.results.is_empty()
            && registry.discovered.is_empty()
            && registry.opened.is_empty()
            && !state.first_search_consumed
        {
            return None;
        }
        let results = registry
            .results
            .iter()
            .map(|result| json!([result.url, result.title]))
            .collect::<Vec<_>>();
        let mut discovered = registry.discovered.iter().collect::<Vec<_>>();
        discovered.sort_unstable();
        let mut opened = registry
            .opened
            .iter()
            .map(|(requested, opened)| json!([requested, opened.tab, opened.landed]))
            .collect::<Vec<_>>();
        opened.sort_unstable_by_key(ToString::to_string);
        Some(json!({
            "results": results,
            "discovered": discovered,
            "opened": opened,
            "planned": state.first_search_consumed,
        }))
    }

    /// Restores a [`Self::snapshot`]: result `r<n>` is again the n-th result.
    pub fn restore(&self, snapshot: &Value) {
        let text = |item: &Value, index: usize| item[index].as_str().unwrap_or("").to_owned();
        let mut state = self.state.lock();
        state.first_search_consumed |= snapshot["planned"] == true;
        let registry = &mut state.registry;
        for item in snapshot["results"].as_array().into_iter().flatten() {
            let url = text(item, 0);
            let key = page_key(&url);
            if url.is_empty() || registry.by_url.contains_key(&key) {
                continue;
            }
            registry.results.push(SearchResultRef {
                id: format!("r{}", registry.results.len() + 1),
                url,
                title: text(item, 1),
            });
            registry.by_url.insert(key, registry.results.len() - 1);
        }
        let discovered = snapshot["discovered"].as_array().into_iter().flatten();
        for url in discovered.filter_map(Value::as_str) {
            if registry.discovered.len() < MAX_DISCOVERED {
                registry.discovered.insert(url.to_owned());
            }
        }
        for item in snapshot["opened"].as_array().into_iter().flatten() {
            let (requested, tab, landed) = (text(item, 0), text(item, 1), text(item, 2));
            if !requested.is_empty() && !tab.is_empty() {
                registry
                    .opened
                    .entry(requested)
                    .or_insert(Opened { tab, landed });
            }
        }
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

impl Registry {
    /// Whether the exact URL `key` is one of this turn's search results.
    fn is_result(&self, key: &str) -> bool {
        self.by_url
            .get(&page_key(key))
            .is_some_and(|index| exact_key(&self.results[*index].url) == key)
    }
}
