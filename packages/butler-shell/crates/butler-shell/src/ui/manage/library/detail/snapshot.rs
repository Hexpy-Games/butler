//! Saved HTML is loaded once per item, independently of metadata edits.
use super::panel::LibraryDetail;
use crate::ui::browser::embed::{EmbeddedPage, html_frame};
use crate::ui::manage::library::types::LibraryItem;
use crate::ui::source::agent::Jobs;
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, Context, IntoElement as _, SharedString, Window};

pub(super) fn frame(
    item: &LibraryItem,
    window: &mut Window,
    cx: &mut Context<LibraryDetail>,
) -> AnyElement {
    let state = window.use_keyed_state(
        SharedString::from(format!("library-html:{}", item.id)),
        cx,
        |_, cx| {
            let id = item.id.clone();
            let request = Jobs::run(cx, move |client| async move {
                client
                    .library_snapshot(&id)
                    .await
                    .ok()
                    .and_then(|v| v["html"].as_str().map(str::to_owned))
            });
            cx.spawn(async move |weak, cx| {
                let html = match request.await.flatten() {
                    Some(html) => {
                        crate::ui::browser::html::HtmlSource::new(
                            html_frame(&html, "allow-popups allow-popups-to-escape-sandbox"),
                            cx,
                        )
                        .await
                    }
                    None => None,
                };
                let _ = weak.update(cx, |state, cx| {
                    *state = Some(html);
                    cx.notify();
                });
                cx.update(gpui::App::refresh_windows);
            })
            .detach();
            None::<Option<crate::ui::browser::html::HtmlSource>>
        },
    );
    let copy = super::copy::words(butler_ds::ui::context::Ds::get(cx).lang());
    let Some(html) = state.read(cx).as_ref() else {
        return Typo::caption(copy.artifact_loading).into_any_element();
    };
    let Some(html) = html else {
        return crate::ui::manage::library::main::media::library_image(item, cx)
            .zip(item.snapshot.as_ref())
            .map(|(src, snapshot)| {
                butler_ds::ui::blocks::artifact_preview::ArtifactPreviewImage::new(
                    src,
                    super::actions::pixels(snapshot.width, snapshot.height),
                )
                .into_any_element()
            })
            .unwrap_or_else(|| Typo::caption(copy.browser_failed).into_any_element());
    };
    let url = html.url().to_owned();
    let frame = EmbeddedPage::frame(&item.id, &url, window, cx);
    if let Some(snapshot) = &item.snapshot {
        let (width, height) = super::actions::pixels(snapshot.width, snapshot.height);
        frame.intrinsic_size(width, height).into_any_element()
    } else {
        frame.into_any_element()
    }
}
