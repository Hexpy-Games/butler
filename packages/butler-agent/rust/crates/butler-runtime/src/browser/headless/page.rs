//! One headless tab as the executor drives it: its CDP sessions and state.
use super::{cdp::Cdp, state::Shared};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

#[derive(Clone)]
pub(crate) struct Page {
    pub cdp: Arc<Cdp>,
    pub shared: Shared,
    pub tab: String,
    pub session: String,
    pub target: String,
}

impl Page {
    pub(crate) async fn send(&self, method: &str, params: Value) -> Result<Value, String> {
        self.cdp.send(method, params, Some(&self.session)).await
    }

    pub(crate) async fn send_to(
        &self,
        session: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.cdp.send(method, params, Some(session)).await
    }

    /// Trusted input that a page dialog may block: a dialog that opens while
    /// the input is handled ends the wait (the page answers after the dialog).
    pub(crate) async fn input(&self, method: &str, params: Value) -> Result<(), String> {
        let Some(mut dialogs) = self.shared.with_tab(&self.tab, |t| t.dialogs.subscribe()) else {
            return Err("tab_closed".into());
        };
        tokio::select! {
            result = self.send(method, params) => result.map(|_| ()),
            _ = dialogs.changed() => Ok(()),
        }
    }

    /// A capture that a page dialog must not hold forever.
    pub(crate) async fn capture(&self, params: Value) -> Option<String> {
        let shot = tokio::time::timeout(
            Duration::from_secs(5),
            self.send("Page.captureScreenshot", params),
        )
        .await
        .ok()?
        .ok()?;
        shot["data"].as_str().map(str::to_owned)
    }

    pub(crate) fn has_dialog(&self) -> bool {
        self.shared
            .with_tab(&self.tab, |t| t.dialog.is_some())
            .unwrap_or(false)
    }

    pub(crate) fn epoch(&self) -> Option<u64> {
        self.shared.with_tab(&self.tab, |t| t.epoch)
    }

    /// The viewport size and scroll offset of the main document.
    pub(crate) async fn viewport(&self) -> Result<Value, String> {
        let context = self
            .world(&self.session.clone(), &self.target.clone())
            .await?;
        self.evaluate_in(&self.session, context,
            "({width:innerWidth,height:innerHeight,x:visualViewport.pageLeft,y:visualViewport.pageTop})").await
    }

    pub(crate) async fn mouse(
        &self,
        kind: &str,
        x: f64,
        y: f64,
        extra: Value,
    ) -> Result<(), String> {
        let mut params = json!({"type":kind,"x":x,"y":y});
        if let (Some(target), Some(extra)) = (params.as_object_mut(), extra.as_object()) {
            target.extend(extra.clone());
        }
        self.input("Input.dispatchMouseEvent", params).await
    }
}
