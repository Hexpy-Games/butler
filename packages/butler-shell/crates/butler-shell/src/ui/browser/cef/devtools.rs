//! Request lifetimes are bounded by their page and execution context.
use super::{CefEngine, PageState};
use crate::ui::browser::engine::{DevToolsReply, TabId};
use butler_cef_host::osr::OsrEvent;
use futures::channel::oneshot;
use serde_json::Value;
use std::collections::HashMap;

pub(super) type Requests = HashMap<i32, oneshot::Sender<anyhow::Result<Value>>>;

pub(super) fn send(
    engine: &CefEngine,
    page: &TabId,
    method: &str,
    params: &Value,
) -> DevToolsReply {
    let (sender, receiver) = oneshot::channel();
    let result = engine
        .ids
        .get(page)
        .ok_or_else(|| anyhow::anyhow!("unknown page"))
        .and_then(|id| {
            let request = engine.runtime.devtools(*id, method, &params.to_string())?;
            let pages = engine.pages.borrow();
            let state = &pages
                .get(id)
                .ok_or_else(|| anyhow::anyhow!("page closed"))?
                .1;
            state.borrow_mut().devtools.insert(request, sender);
            Ok(())
        });
    // On failure dropping the sender cancels the receiver.
    let _ = result;
    receiver
}

pub(super) fn receive(event: &OsrEvent, state: &mut PageState) -> bool {
    match event {
        OsrEvent::DevTools { id, result_json } => {
            if let Some(sender) = state.devtools.remove(id) {
                let value = serde_json::from_str::<Value>(result_json)
                    .map_err(anyhow::Error::from)
                    .and_then(|v| {
                        if v.get("error").is_some() {
                            anyhow::bail!("DevTools: {}", v["error"]);
                        }
                        Ok(v["result"].clone())
                    });
                let _ = sender.send(value);
            }
            true
        }
        OsrEvent::DevToolsEvent { method, .. } if method == "Runtime.executionContextsCleared" => {
            state.devtools.clear();
            false
        }
        _ => false,
    }
}
