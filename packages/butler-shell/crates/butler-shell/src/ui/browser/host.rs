//! Coalesced browser-host snapshots; a changed revision is sent after the in-flight request.
use super::{agent_host::Hosted, engine::Profile, model::Tab};
use crate::ui::source::agent::Jobs;
use futures::{
    StreamExt as _,
    channel::{mpsc, oneshot},
};
use gpui::App;
use serde_json::{Value, json};
use std::{cell::RefCell, rc::Rc};

#[derive(Clone)]
pub(super) struct Publisher {
    state: Rc<RefCell<(u64, Value)>>,
    changed: mpsc::UnboundedSender<()>,
    waiters: Rc<RefCell<Vec<oneshot::Sender<bool>>>>,
}
impl Publisher {
    pub(super) fn start(cx: &mut App) -> Self {
        let (changed, mut receive) = mpsc::unbounded();
        let state = Rc::new(RefCell::new((0, json!({"tabs":[],"still_backlog":0}))));
        let pending = state.clone();
        let waiters: Rc<RefCell<Vec<oneshot::Sender<bool>>>> = Rc::default();
        let waiting = waiters.clone();
        cx.spawn(async move |cx| {
            let mut published = 0;
            while receive.next().await.is_some() {
                loop {
                    let (revision, snapshot) = pending.borrow().clone();
                    if revision == published {
                        for send in waiting.borrow_mut().drain(..) {
                            let _ = send.send(true);
                        }
                        break;
                    }
                    let request = cx.update(|cx| {
                        Jobs::run(cx, move |client| async move {
                            client.browser_host_events(&snapshot).await
                        })
                    });
                    if matches!(request.await, Some(Ok(_))) {
                        published = revision;
                    } else {
                        for send in waiting.borrow_mut().drain(..) {
                            let _ = send.send(false);
                        }
                        break;
                    }
                }
            }
        })
        .detach();
        Self {
            state,
            changed,
            waiters,
        }
    }
    /// Publishes the current snapshot again, as on a fresh attachment.
    pub(super) fn resend(&self) {
        self.state.borrow_mut().0 += 1;
        let _ = self.changed.unbounded_send(());
    }
    pub(super) fn ready(&self) -> oneshot::Receiver<bool> {
        let (send, receive) = oneshot::channel();
        self.waiters.borrow_mut().push(send);
        let _ = self.changed.unbounded_send(());
        receive
    }
    pub(super) fn changed(&self, tabs: &[Tab]) {
        let tabs: Vec<_> = tabs.iter().filter(|tab| tab.hosted.as_ref().is_none_or(|h| !h.internal)).map(|tab| json!({
            "id":tab.id.0.as_ref(), "owner":super::area::owner_key(&tab.owner),
            "profile":match tab.profile { Profile::SignedIn => "signed_in", Profile::SignedOut => "signed_out" },
            "epoch":tab.epoch, "holder":tab.hosted.as_ref().map_or("user", |h| h.holder.name()), "url":tab.url, "title":tab.title,
            "status":format!("{:?}",tab.status).to_lowercase(), "favicon":tab.favicon,
            "opener":tab.opener.as_ref().map(|id|id.0.as_ref()), "popup":tab.popup,
            "dialog":tab.dialog, "blockedPopup":tab.blocked_popup,
            "canBack":tab.can_back, "canForward":tab.can_forward,
            "agent":tab.hosted.is_some(),"driven":false,"sticky":tab.hosted.as_ref().is_some_and(|h| h.sticky),
            "waiting":tab.hosted.as_ref().is_some_and(|h| h.waiting),"busy":tab.hosted.as_ref().is_some_and(Hosted::busy),
            "inUse":tab.hosted.as_ref().is_some_and(Hosted::in_use),"paused":tab.hosted.as_ref().is_some_and(|h| h.paused),
            "signinStep":tab.hosted.as_ref().and_then(Hosted::signin_step),"payStep":tab.hosted.as_ref().and_then(Hosted::pay_step),"privacyFrozen":false,"picking":tab.picking,"selectionCount":tab.selections.len(),"stills":true
        })).collect();
        let next = json!({"tabs":tabs,"still_backlog":0});
        let mut state = self.state.borrow_mut();
        if state.1 != next {
            state.0 += 1;
            state.1 = next;
            let _ = self.changed.unbounded_send(());
        }
    }
}
