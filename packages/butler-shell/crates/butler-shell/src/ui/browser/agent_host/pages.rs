//! Page host calls: the Agent opens, holds and closes hosted pages and reports their use.
use super::{Holder, Hosted, Stage, relay};
use crate::ui::{
    browser::{
        area::owner_key,
        engine::{DevToolsReply, Profile, TabId},
        model::{BrowserState, Owner, Tab},
    },
    source::{agent::Jobs, fetch::sleep},
};
use futures::future::{Either, select};
use gpui::{App, BorrowAppContext as _, Task, px, size};
use serde_json::{Value, json};
use std::time::Duration;

/// The one owner of every internal page; it cannot parse as a real conversation.
const INTERNAL_OWNER: &str = "butler:utility";
/// How long the Agent's call may wait when its frame names no deadline.
const LOOKUP: Duration = Duration::from_secs(20);

fn tab_id(value: &Value) -> TabId {
    TabId(value.as_str().unwrap_or_default().to_owned().into())
}

fn unavailable(reason: &str) -> Value {
    json!({"status":"unavailable","reason":reason})
}

fn valid_context(context: &str) -> bool {
    !context.is_empty()
        && context.len() <= 200
        && context
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'-'))
}

pub(super) fn call(frame: &Value, cx: &mut App) {
    let args = &frame["args"];
    let id = frame["id"].as_str().unwrap_or_default().to_owned();
    match frame["op"].as_str() {
        Some("page.open") => {
            let deadline = frame["deadline_ms"]
                .as_u64()
                .map_or(LOOKUP, Duration::from_millis);
            open(id, args, deadline, cx);
        }
        Some("page.close") => {
            let tab = tab_id(&args["tab"]);
            cx.update_global::<BrowserState, _>(|model, cx| {
                if model.tab(&tab).is_some_and(|tab| tab.hosted.is_some()) {
                    model.close(&tab, cx);
                }
            });
            reply(id, json!({"status":"ok"}), cx);
        }
        Some("page.hold") => {
            let value = cx.update_global::<BrowserState, _>(|model, _| model.hold(args));
            reply(id, value, cx);
        }
        Some(op @ ("use.started" | "use.ended")) => {
            let tab = tab_id(&frame["tab"]);
            cx.update_global::<BrowserState, _>(|model, _| {
                model.use_changed(&tab, op == "use.started");
                model.call_changed(op == "use.started");
            });
        }
        Some("owner.closed") => {
            let owner = Owner::parse(&format!(
                "conversation:{}",
                frame["session"].as_str().unwrap_or_default()
            ));
            cx.update_global::<BrowserState, _>(|model, cx| {
                let tabs: Vec<_> = model
                    .tabs()
                    .iter()
                    .filter(|tab| owner.as_ref().is_ok_and(|owner| &tab.owner == owner))
                    .map(|tab| tab.id.clone())
                    .collect();
                for tab in tabs {
                    model.close(&tab, cx);
                }
            });
        }
        _ => {}
    }
}

/// The snapshot is flushed and acknowledged before the answer goes.
fn reply(id: String, value: Value, cx: &mut App) {
    let ready = cx.global::<BrowserState>().publisher.ready();
    cx.spawn(async move |cx| {
        let _ = ready.await;
        let _ = cx
            .update(|cx| {
                Jobs::run(cx, move |client| async move {
                    client.browser_host_result(&id, &value).await
                })
            })
            .await;
    })
    .detach();
}

fn open(id: String, args: &Value, deadline: Duration, cx: &mut App) {
    let created = cx.update_global::<BrowserState, _>(|model, _| model.open_hosted(args));
    let tab = match created {
        Ok(tab) => tab,
        Err(reason) => return reply(id, unavailable(reason), cx),
    };
    let target =
        cx.global::<BrowserState>()
            .engine
            .devtools(&tab, "Target.getTargetInfo", &json!({}));
    cx.spawn(async move |cx| {
        let target = target_id(target, sleep(cx, deadline)).await;
        cx.update(|cx| {
            let value =
                cx.update_global::<BrowserState, _>(|model, cx| model.opened(&tab, target, cx));
            reply(id, value, cx);
        });
    })
    .detach();
}

/// The page's CDP target id; `None` when the lookup fails or `timeout` fires first.
async fn target_id(reply: DevToolsReply, timeout: Task<()>) -> Option<String> {
    match select(reply, timeout).await {
        Either::Left((reply, _)) => {
            let value = reply.ok()?.ok()?;
            value["targetInfo"]["targetId"].as_str().map(str::to_owned)
        }
        Either::Right(_) => None,
    }
}

/// The stream ended: pages the Agent held (and internal pages) close, pages the user took over
/// become ordinary tabs.
pub(super) fn reset(cx: &mut App) {
    cx.update_global::<BrowserState, _>(|model, cx| {
        let hosted: Vec<_> = model
            .tabs()
            .iter()
            .filter_map(|tab| {
                let hosted = tab.hosted.as_ref()?;
                Some((
                    tab.id.clone(),
                    hosted.holder == Holder::Agent || hosted.internal,
                ))
            })
            .collect();
        for (id, close) in hosted {
            if close {
                model.close(&id, cx);
            } else {
                model.end_hosting(&id, cx);
            }
        }
        model.calls = 0;
        model.publisher.changed(&model.tabs);
    });
    relay::clear(cx);
}

impl BrowserState {
    /// A hosted page ignores the pane's size but remembers it. True when `id` is hosted.
    pub(in crate::ui::browser) fn note_pane(
        &mut self,
        id: &TabId,
        size: gpui::Size<gpui::Pixels>,
        scale: f32,
    ) -> bool {
        let hosted = self
            .tabs
            .iter_mut()
            .find(|tab| &tab.id == id)
            .and_then(|tab| tab.hosted.as_mut());
        hosted.is_some_and(|hosted| {
            hosted.pane = Some((size, scale));
            true
        })
    }

    /// A hosted page's size is fixed whatever the pane asks.
    pub(in crate::ui::browser) fn fix_hosted_size(&mut self, id: &TabId) {
        if let Some(tab) = self.tab(id) {
            tab.pick.viewport.set((1280., 800.));
        }
        self.engine.resize(id, size(px(1280.), px(800.)), 1.);
    }

    /// The tab stops being a hosted page: the Agent hears of its end, the page keeps running.
    pub(in crate::ui::browser) fn end_hosting(&mut self, id: &TabId, cx: &App) {
        let Some(tab) = self
            .tabs
            .iter_mut()
            .find(|tab| &tab.id == id && tab.hosted.is_some())
        else {
            return;
        };
        relay::closed(cx, tab);
        let pane = tab.hosted.take().and_then(|hosted| hosted.pane);
        #[cfg(feature = "cef")]
        relay::release(&*self.engine, id);
        self.engine.devtools_raw_end(id);
        self.engine.keep_awake(id, false);
        if let Some((size, scale)) = pane {
            self.resize(id, size, scale);
        }
        self.publisher.changed(&self.tabs);
    }

    /// A real page at once: `about:blank` at the fixed size the Agent's tools measure against.
    fn open_hosted(&mut self, args: &Value) -> Result<TabId, &'static str> {
        if !self.engine.enabled() || !self.engine.supports_devtools() {
            return Err("no_browser");
        }
        let internal = args["internal"].as_bool().unwrap_or(false);
        let owner = if internal {
            Owner::Conversation(INTERNAL_OWNER.into())
        } else {
            match Owner::parse(args["owner"].as_str().unwrap_or_default()) {
                Ok(owner @ Owner::Conversation(_)) => owner,
                _ => return Err("invalid_owner"),
            }
        };
        let key = owner_key(&owner);
        let (profile, partition) = match args["profile"].as_str() {
            Some("signed_in") => (Profile::SignedIn, key.clone()),
            Some("signed_out") => {
                let context = args["context"].as_str().unwrap_or_default();
                if !valid_context(context) {
                    return Err("invalid_context");
                }
                (Profile::SignedOut, format!("agent:{context}"))
            }
            _ => return Err("invalid_profile"),
        };
        self.next_id += 1;
        let id = TabId(format!("t{}", self.next_id).into());
        self.tabs.push(Tab {
            hosted: Some(self.new_hosted(internal)),
            ..Tab::new(id.clone(), owner, profile, String::new())
        });
        self.engine
            .open(&id, "about:blank", profile, &key, &partition);
        self.engine.keep_awake(&id, true);
        self.fix_hosted_size(&id);
        self.publisher.changed(&self.tabs);
        Ok(id)
    }

    /// The opened page's answer once its target id is known; a page without one is closed.
    fn opened(&mut self, tab: &TabId, target: Option<String>, cx: &mut App) -> Value {
        let found = self
            .tabs
            .iter_mut()
            .find(|candidate| &candidate.id == tab)
            .and_then(|candidate| Some((candidate.epoch, candidate.hosted.as_mut()?)));
        match (found, target) {
            (Some((epoch, hosted)), Some(target)) => {
                hosted.target.clone_from(&target);
                self.publisher.changed(&self.tabs);
                json!({"status":"ok","tab":tab.0.as_ref(),"target":target,"epoch":epoch})
            }
            (Some(_), None) => {
                self.close(tab, cx);
                unavailable("target_unavailable")
            }
            (None, _) => unavailable("closed"),
        }
    }

    fn hold(&mut self, args: &Value) -> Value {
        let id = tab_id(&args["tab"]);
        let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == id) else {
            return unavailable("unknown_tab");
        };
        let Some(hosted) = tab.hosted.as_mut() else {
            return unavailable("unknown_tab");
        };
        let holder = match args["holder"].as_str() {
            Some("agent") => Some(Holder::Agent),
            Some("user") => Some(Holder::User),
            _ => None,
        };
        if let Some(holder) = holder.filter(|holder| *holder != hosted.holder) {
            hosted.holder = holder;
            tab.epoch += 1;
        }
        hosted.sticky = args["sticky"].as_bool().unwrap_or(hosted.sticky);
        hosted.waiting = args["waiting"].as_bool().unwrap_or(hosted.waiting);
        let epoch = tab.epoch;
        self.publisher.changed(&self.tabs);
        json!({"status":"ok","epoch":epoch})
    }

    fn use_changed(&mut self, id: &TabId, started: bool) {
        let Some(hosted) = self
            .tabs
            .iter_mut()
            .find(|tab| &tab.id == id)
            .and_then(|tab| tab.hosted.as_mut())
        else {
            return;
        };
        hosted.uses = if started {
            hosted.stage = Stage::Open;
            hosted.uses.saturating_add(1)
        } else {
            hosted.uses.saturating_sub(1)
        };
        let awake = hosted.awake();
        self.engine.keep_awake(id, awake);
        self.publisher.changed(&self.tabs);
    }

    /// A call started or ended; the opening of every hosted page ends with the last call.
    fn call_changed(&mut self, started: bool) {
        if started {
            self.calls = self.calls.saturating_add(1);
            return;
        }
        self.calls = self.calls.saturating_sub(1);
        if self.calls > 0 {
            return;
        }
        for tab in &mut self.tabs {
            if let Some(hosted) = tab
                .hosted
                .as_mut()
                .filter(|hosted| hosted.stage == Stage::Opening)
            {
                hosted.stage = Stage::Open;
                self.engine.keep_awake(&tab.id, hosted.awake());
            }
        }
    }

    /// A new hosted page: still opening while any call is in flight.
    pub(in crate::ui::browser) fn new_hosted(&self, internal: bool) -> Hosted {
        let stage = if self.calls > 0 {
            Stage::Opening
        } else {
            Stage::Open
        };
        Hosted {
            stage,
            ..Hosted::agent(internal)
        }
    }

    /// A popup of a hosted page is a hosted page itself; the Agent hears of it with its target.
    /// A popup whose target cannot be found is closed.
    #[cfg(feature = "cef")]
    pub(in crate::ui::browser) fn announce_popup(
        &self,
        id: &TabId,
        opener: &TabId,
        url: &str,
        cx: &mut App,
    ) {
        let Some(opener_target) = self
            .tab(opener)
            .and_then(|tab| tab.hosted.as_ref())
            .map(|hosted| hosted.target.clone())
        else {
            return;
        };
        let target = self.engine.devtools(id, "Target.getTargetInfo", &json!({}));
        let (id, url) = (id.clone(), url.to_owned());
        cx.spawn(async move |cx| {
            let target = target_id(target, sleep(cx, LOOKUP)).await;
            cx.update(|cx| {
                let known = cx.update_global::<BrowserState, _>(|model, cx| {
                    let hosted = model
                        .tabs
                        .iter_mut()
                        .find(|tab| tab.id == id)
                        .and_then(|tab| tab.hosted.as_mut());
                    match (hosted, &target) {
                        (Some(hosted), Some(target)) => {
                            hosted.target.clone_from(target);
                            true
                        }
                        (Some(_), None) => {
                            model.close(&id, cx);
                            false
                        }
                        (None, _) => false,
                    }
                });
                if let (true, Some(target)) = (known, target) {
                    relay::event(
                        cx,
                        json!({"method":"Target.attachedToTarget","params":{
                        "sessionId":id.0.as_ref(),
                        "targetInfo":{"targetId":target,"type":"page","url":url,"title":"",
                            "openerId":opener_target},
                        "waitingForDebugger":false}}),
                    );
                }
            });
        })
        .detach();
    }
}
