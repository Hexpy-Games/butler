//! Where the browser went, as R5 provenance: the page a tab shows now and the
//! pages a page opened or tried to open (popups, redirects, followed links).
//! The browser requested these, or a page asked it to; the model did not
//! compose them. Reading one with `web_read` sends nothing new, so it is
//! found like a search result. Text on a page is not: a page can echo what
//! the model typed, so a URL written there may be one the model composed.
use super::super::GuidedTools;
use butler_core::json::JsonDocument;
use serde::Deserialize;

/// The parts of a browser result that report locations: a record's
/// `untrusted_content.url`, for the result itself, its folded act batch,
/// each browser event and each listed tab.
#[derive(Default, Deserialize)]
#[serde(default)]
struct Reached {
    untrusted_content: Option<Location>,
    action: Option<Box<Node>>,
    events: Vec<Node>,
    tabs: Vec<Node>,
}

/// A nested record, or anything else in its place (which reports nothing).
#[derive(Deserialize)]
#[serde(untagged)]
enum Node {
    Record(Reached),
    Other(serde::de::IgnoredAny),
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Location {
    url: Option<String>,
}

impl Reached {
    fn urls<'a>(&'a self, found: &mut Vec<&'a str>) {
        if let Some(url) = self
            .untrusted_content
            .as_ref()
            .and_then(|c| c.url.as_deref())
        {
            found.push(url);
        }
        let nested = self.action.as_deref().into_iter();
        for node in nested.chain(&self.events).chain(&self.tabs) {
            if let Node::Record(record) = node {
                record.urls(found);
            }
        }
    }
}

/// Records the locations a finished (or replayed) browser call reports as
/// found by this turn. A result in another shape reports none.
pub(in crate::host::guided::tools) fn discover(
    owner: &GuidedTools,
    name: &str,
    output: &JsonDocument,
) {
    if !name.starts_with("browser_") {
        return;
    }
    let Ok(reached) = output.read::<Reached>() else {
        return;
    };
    let mut found = Vec::new();
    reached.urls(&mut found);
    for url in found {
        if url.starts_with("http://") || url.starts_with("https://") {
            owner.web_session.discover(url);
        }
    }
}
