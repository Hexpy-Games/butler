//! Change-driven, single-flight history commits (`browser/history.mjs`).
use super::{
    engine::TabId,
    model::{BrowserState, Owner, Tab},
};
use crate::ui::source::agent::Jobs;
use gpui::{App, Global};
use serde_json::{Value, json};
use std::collections::VecDeque;

#[derive(Clone, Copy)]
pub(super) enum Transition {
    Typed,
    ForwardBack,
    Reload,
}
impl Transition {
    fn name(self) -> &'static str {
        match self {
            Self::Typed => "typed",
            Self::ForwardBack => "forward_back",
            Self::Reload => "reload",
        }
    }
}
#[derive(Default)]
struct VisitQueue {
    pending: VecDeque<Value>,
    flushing: bool,
}
impl Global for VisitQueue {}
pub(super) fn init(cx: &mut App) {
    cx.set_global(VisitQueue::default());
}

pub(super) fn committed(tab: &mut Tab, cx: &mut App) {
    let transition = tab.last_nav.take().map_or("link", Transition::name);
    let Ok(url) = url::Url::parse(&tab.url) else {
        return;
    };
    if !matches!(url.scheme(), "http" | "https")
        || ["/__p/", "/__o/"].iter().any(|p| url.path().starts_with(p))
    {
        return;
    }
    let conversation = match &tab.owner {
        Owner::Mine => None,
        Owner::Conversation(id) => Some(id.as_ref()),
    };
    add(
        json!({"_tab": tab.id.0.as_ref(), "url":tab.url, "title":tab.url, "favicon":"", "visitedAt":chrono::Utc::now().to_rfc3339(),
        "transition":transition, "tabKind":if conversation.is_some() {"conversation"} else {"mine"},
        "conversationId":conversation, "butlerDriven":false, "background":false, "source":"butler"}),
        cx,
    );
}
fn add(visit: Value, cx: &mut App) {
    let queue = cx.global_mut::<VisitQueue>();
    queue.pending.push_back(visit);
    if !queue.flushing {
        queue.flushing = true;
        cx.defer(flush);
    }
}
fn flush(cx: &mut App) {
    let queue = cx.global_mut::<VisitQueue>();
    let count = queue.pending.len().min(100);
    let batch: Vec<_> = queue.pending.drain(..count).collect();
    if batch.is_empty() {
        queue.flushing = false;
        return;
    }
    let mut visits = batch.clone();
    for visit in &mut visits {
        let tab = visit["_tab"].as_str().and_then(|id| {
            cx.global::<BrowserState>()
                .tab(&TabId(id.to_owned().into()))
        });
        if let Some(tab) = tab {
            if !tab.title.is_empty() && visit["url"].as_str() == Some(tab.title_url.as_str()) {
                visit["title"] = json!(tab.title);
            }
            if visit["url"].as_str() == Some(tab.favicon_url.as_str()) {
                visit["favicon"] = json!(tab.favicon);
            }
        }
        if let Some(object) = visit.as_object_mut() {
            object.remove("_tab");
            if object.get("conversationId").is_some_and(Value::is_null) {
                object.remove("conversationId");
            }
        }
    }
    let request = Jobs::run(cx, move |client| async move {
        client.browser_host_visits(&json!({"visits":visits})).await
    });
    cx.spawn(async move |cx| {
        let saved = matches!(request.await, Some(Ok(_)));
        cx.update(|cx| {
            let queue = cx.global_mut::<VisitQueue>();
            if saved {
                cx.defer(flush);
            } else {
                for visit in batch.into_iter().rev() {
                    queue.pending.push_front(visit);
                }
                queue.flushing = false;
                eprintln!("browser history visit batch could not be saved");
            }
        });
    })
    .detach();
}
