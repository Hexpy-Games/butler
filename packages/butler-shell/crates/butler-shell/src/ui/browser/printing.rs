//! Hidden embeds live only for one render or print, including failure and cancellation.
use super::{embed::EmbedHandle, engine::Profile, model::BrowserState};
use futures::channel::oneshot;
use gpui::AsyncApp;
use std::path::Path;

pub(crate) struct HiddenPage {
    handle: EmbedHandle,
    app: AsyncApp,
    source: Option<super::html::HtmlSource>,
}

impl Drop for HiddenPage {
    fn drop(&mut self) {
        self.app
            .update(|cx| cx.global_mut::<BrowserState>().embed_close(&self.handle));
    }
}

impl HiddenPage {
    pub(crate) async fn load_html(html: String, cx: &mut AsyncApp) -> Option<Self> {
        let source = super::html::HtmlSource::new(html, cx).await?;
        let mut page = Self::load(source.url(), cx).await?;
        page.source = Some(source);
        Some(page)
    }

    pub(crate) async fn load(url: &str, cx: &mut AsyncApp) -> Option<Self> {
        let (send, done) = oneshot::channel();
        let handle = cx.update(|cx| {
            let state = cx.global_mut::<BrowserState>();
            if !state.engine.supports_devtools() {
                return None;
            }
            let handle = state.embed_open(url, Profile::SignedOut);
            state.engine.embed_visible(&handle.0, false);
            state.embeds.get_mut(&handle.0)?.loaded = Some(send);
            Some(handle)
        })?;
        let page = Self {
            handle,
            app: cx.clone(),
            source: None,
        };
        done.await.ok()?.then_some(page)
    }

    pub(crate) async fn html(&self, cx: &mut AsyncApp) -> Option<String> {
        let reply = cx.update(|cx| cx.global::<BrowserState>().engine.devtools(&self.handle.0, "Runtime.evaluate", &serde_json::json!({
            "expression":"document.documentElement.dataset.exportReady === 'true' ? document.documentElement.outerHTML : null", "returnByValue":true
        })));
        reply.await.ok()?.ok()?["result"]["value"]
            .as_str()
            .map(str::to_owned)
    }

    pub(crate) async fn print(&self, path: &Path, cx: &mut AsyncApp) -> Option<()> {
        let (send, done) = oneshot::channel();
        cx.update(|cx| {
            let state = cx.global_mut::<BrowserState>();
            state.embeds.get_mut(&self.handle.0)?.printed = Some(send);
            state
                .engine
                .print_to_pdf(&self.handle.0, path)
                .then_some(())
        })?;
        done.await.ok()?.then_some(())
    }
}
