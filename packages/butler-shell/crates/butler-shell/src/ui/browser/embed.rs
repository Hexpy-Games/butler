//! Non-tab pages owned by the element displaying a capability.
use super::{
    engine::{PageEvent, Profile, TabId},
    model::BrowserState,
    page_dialog::PageDialog,
};
use butler_ds::ui::blocks::artifact_preview::ArtifactPreviewFrame;
use gpui::{
    App, BorrowAppContext as _, Context, IntoElement as _, ParentElement as _, Render,
    SharedString, Styled as _, Window, canvas, div,
};

pub(crate) struct Embed {
    pub(super) dialog: Option<PageDialog>,
    pub(crate) loaded: Option<futures::channel::oneshot::Sender<bool>>,
    pub(crate) printed: Option<futures::channel::oneshot::Sender<bool>>,
}

#[derive(Clone)]
pub(crate) struct EmbedHandle(pub(crate) TabId);

impl BrowserState {
    pub(crate) fn embed_open(&mut self, url: &str, profile: Profile) -> EmbedHandle {
        self.next_id += 1;
        let id = TabId(format!("embed-{}", self.next_id).into());
        self.embeds.insert(
            id.clone(),
            Embed {
                dialog: None,
                loaded: None,
                printed: None,
            },
        );
        self.engine.open_embed(&id, url, profile);
        EmbedHandle(id)
    }

    pub(crate) fn embed_close(&mut self, handle: &EmbedHandle) {
        if self.embeds.remove(&handle.0).is_some() {
            self.engine.close(&handle.0);
        }
    }
}

pub(super) fn event(event: &PageEvent, cx: &mut App) -> bool {
    if !cx.global::<BrowserState>().embeds.contains_key(&event.page) {
        return false;
    }
    match &event.change {
        super::engine::PageChange::Loaded(ok) => {
            if let Some(sender) = cx
                .global_mut::<BrowserState>()
                .embeds
                .get_mut(&event.page)
                .and_then(|e| e.loaded.take())
            {
                let _ = sender.send(*ok);
            }
        }
        super::engine::PageChange::PdfDone(ok) => {
            if let Some(sender) = cx
                .global_mut::<BrowserState>()
                .embeds
                .get_mut(&event.page)
                .and_then(|e| e.printed.take())
            {
                let _ = sender.send(*ok);
            }
        }
        super::engine::PageChange::Crashed => {
            if let Some(embed) = cx.global_mut::<BrowserState>().embeds.get_mut(&event.page) {
                if let Some(sender) = embed.loaded.take() {
                    let _ = sender.send(false);
                }
                if let Some(sender) = embed.printed.take() {
                    let _ = sender.send(false);
                }
            }
        }
        #[cfg(feature = "cef")]
        super::engine::PageChange::PopupNewTab(url) => {
            if super::address::web_url(url).is_some() {
                super::open_link(url, cx);
            }
        }
        #[cfg(feature = "cef")]
        super::engine::PageChange::Dialog(dialog) => {
            if let Some(embed) = cx.global_mut::<BrowserState>().embeds.get_mut(&event.page) {
                embed.dialog = Some(dialog.clone());
            }
        }
        _ => {}
    }
    true
}

pub(crate) struct EmbeddedPage {
    handle: EmbedHandle,
}

impl EmbeddedPage {
    pub(crate) fn frame(
        id: &str,
        url: &str,
        window: &mut Window,
        cx: &mut App,
    ) -> ArtifactPreviewFrame {
        let key = SharedString::from(format!("embedded-page:{id}:{url}"));
        let page = window.use_keyed_state(key, cx, |_, cx| {
            let handle = cx
                .global_mut::<BrowserState>()
                .embed_open(url, Profile::SignedOut);
            cx.on_release(|this: &mut Self, cx| {
                cx.global_mut::<BrowserState>().embed_close(&this.handle);
            })
            .detach();
            Self { handle }
        });
        ArtifactPreviewFrame::new().page(page)
    }
}

impl Render for EmbeddedPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl gpui::IntoElement {
        let id = self.handle.0.clone();
        let surface =
            cx.update_global::<BrowserState, _>(|state, cx| state.engine.surface(&id, window, cx));
        let mut page = div().size_full().relative().children(surface);
        if let Some(dialog) = cx
            .global::<BrowserState>()
            .embeds
            .get(&id)
            .and_then(|e| e.dialog.clone())
        {
            page = page.child(
                div()
                    .absolute()
                    .inset_0()
                    .child(super::dialog::show(&id, &dialog, window, cx)),
            );
        }
        let measure = canvas(
            |bounds, _, _| bounds,
            move |_, bounds: gpui::Bounds<gpui::Pixels>, window, cx| {
                cx.global_mut::<BrowserState>().engine.resize(
                    &id,
                    bounds.size,
                    window.scale_factor(),
                );
            },
        )
        .absolute()
        .size_full();
        page.child(measure).into_any_element()
    }
}

/// A srcDoc-equivalent frame; the browser enforces the same sandbox as Electron.
pub(crate) fn html_frame(html: &str, sandbox: &str) -> String {
    let escaped = html
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;");
    format!(
        "<!doctype html><html><head><style>html,body,iframe{{margin:0;border:0;width:100%;height:100%;display:block}}</style></head><body><iframe sandbox=\"{sandbox}\" referrerpolicy=\"no-referrer\" srcdoc=\"{escaped}\"></iframe></body></html>"
    )
}
