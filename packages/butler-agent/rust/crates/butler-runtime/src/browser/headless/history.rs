//! Change-driven conversation visits. Hidden helper pages never enter the queue.
use super::{browser::Browser, state::Tab};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
};
pub type VisitFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
pub trait HistoryPort: Send + Sync {
    fn record(&self, visits: Vec<Value>) -> VisitFuture;
}
#[derive(Default)]
pub(crate) struct History {
    port: Mutex<Option<tokio::sync::mpsc::UnboundedSender<Value>>>,
    pending: Mutex<HashMap<String, Vec<Value>>>,
    /// Hook for a future private mode, consulted at navigation and completion.
    private: AtomicBool,
}
impl History {
    pub(crate) fn set_port(&self, port: Arc<dyn HistoryPort>) {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        *self.port.lock().unwrap_or_else(PoisonError::into_inner) = Some(sender);
        tokio::spawn(async move {
            while let Some(visit) = receiver.recv().await {
                let mut batch = vec![visit];
                while batch.len() < 100 {
                    match receiver.try_recv() {
                        Ok(v) => batch.push(v),
                        Err(_) => break,
                    }
                }
                if port.record(batch).await.is_err() {
                    eprintln!("browser history visit batch could not be saved");
                }
            }
        });
    }
    pub(crate) fn set_private(&self, private: bool) {
        self.private.store(private, Ordering::Relaxed);
    }
    pub(crate) fn navigation(&self, tab: &mut Tab, url: &str, transition: &str) {
        if tab.hidden.is_some() || tab.preview.is_some() || self.private.load(Ordering::Relaxed) {
            return;
        }
        let Some(session) = tab.owner.strip_prefix("conversation:") else {
            return;
        };
        let Ok(parsed) = url::Url::parse(url) else {
            return;
        };
        if !matches!(parsed.scheme(), "http" | "https")
            || ["/__p/", "/__o/"]
                .iter()
                .any(|p| parsed.path().starts_with(p))
        {
            return;
        }
        let transition = tab
            .history_transition
            .take()
            .unwrap_or_else(|| transition.into());
        let visit = json!({"url":parsed.as_str(),"title":parsed.as_str(),"favicon":"","visitedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"transition":transition,"tabKind":"conversation","conversationId":session,"butlerDriven":true,"background":true,"source":"butler"});
        if let Some(sender) = &*self.port.lock().unwrap_or_else(PoisonError::into_inner) {
            let _sent = sender.send(visit.clone());
        }
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(tab.id.clone())
            .or_default()
            .push(visit);
    }
    pub(crate) fn complete(&self, tab: &str, url: &str, title: &str, favicon: &str) {
        let visits = self
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(tab)
            .unwrap_or_default();
        if self.private.load(Ordering::Relaxed) {
            return;
        }
        let sender = self.port.lock().unwrap_or_else(PoisonError::into_inner);
        for mut visit in visits {
            if visit["url"] != url {
                continue;
            }
            if !title.is_empty() {
                visit["title"] = json!(title);
            }
            visit["favicon"] = json!(favicon);
            visit["metadataOnly"] = json!(true);
            if let Some(sender) = &*sender {
                let _sent = sender.send(visit);
            }
        }
    }
}
pub(crate) fn event(browser: &Arc<Browser>, session: &str, method: &str, params: &Value) {
    let mut state = browser.shared.lock();
    let Some(id) = state.tab_of_session(session) else {
        return;
    };
    let Some(tab) = state.tabs.get_mut(&id) else {
        return;
    };
    if session != tab.session {
        return;
    }
    let main = method == "Page.frameNavigated" && params["frame"]["parentId"].is_null()
        || method == "Page.navigatedWithinDocument" && params["frameId"] == tab.target;
    if main {
        let url = if method == "Page.frameNavigated" {
            &params["frame"]["url"]
        } else {
            &params["url"]
        };
        browser.history.navigation(
            tab,
            url.as_str().unwrap_or(""),
            if method == "Page.navigatedWithinDocument" {
                "same_document"
            } else {
                "link"
            },
        );
    }
    if method != "Page.loadEventFired" && method != "Page.navigatedWithinDocument" {
        return;
    }
    let id = tab.id.clone();
    let title = tab.title.clone();
    drop(state);
    let browser = browser.clone();
    let session = session.to_owned();
    tokio::spawn(async move {
        let result = browser.cdp.send("Runtime.evaluate",json!({"expression":"({url:location.href,title:document.title,favicon:document.querySelector('link[rel~=icon]')?.href||''})","returnByValue":true}),Some(&session)).await.unwrap_or(Value::Null);
        let value = &result["result"]["value"];
        browser.history.complete(
            &id,
            value["url"].as_str().unwrap_or(""),
            value["title"].as_str().unwrap_or(&title),
            value["favicon"].as_str().unwrap_or(""),
        );
    });
}
