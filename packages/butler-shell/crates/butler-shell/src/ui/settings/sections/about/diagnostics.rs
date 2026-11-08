//! `DiagnosticsExportField.tsx`: saves the logs without content (no bodies).
use std::path::PathBuf;

use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use gpui::{Context, IntoElement};
use serde_json::json;

use super::AboutPage;
use super::copy::words;
use crate::ui::source::agent::Jobs;

pub(super) fn field(page: &AboutPage, cx: &mut Context<AboutPage>) -> impl IntoElement {
    let copy = words(Ds::get(cx).lang());
    let mut export = Button::new("diagnostics-export")
        .size(Size::Sm)
        .variant(Variant::Outline)
        .text(copy.diagnostics_export)
        .on_click(cx.listener(|this, _, _, cx| this.export_diagnostics(cx)));
    if page.exporting {
        export = export.disabled();
    }
    SettingsField::new(copy.diagnostics_label)
        .description(copy.diagnostics_description)
        .control(export)
}

impl AboutPage {
    /// `exportLogs({ includeBodies: false })`: the save dialog, then the zip written there.
    fn export_diagnostics(&mut self, cx: &mut Context<Self>) {
        self.exporting = true;
        cx.notify();
        let directory = butler_platform::user_dirs::non_empty_home_dir()
            .map_or_else(PathBuf::new, |home| home.join("Downloads"));
        let ask = cx.prompt_for_new_path(&directory, Some("butler-logs.zip"));
        let copy = words(Ds::get(cx).lang());
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(path))) = ask.await else {
                let _ = this.update(cx, |this, cx| {
                    this.exporting = false;
                    cx.notify();
                });
                return;
            };
            let download = cx.update(|cx| {
                Jobs::run(cx, |client| async move {
                    let file = client
                        .export_logs(&json!({ "include_bodies": false }))
                        .await
                        .ok()?;
                    Some(file.bytes)
                })
            });
            let written = match download.await.flatten() {
                Some(bytes) => cx
                    .background_executor()
                    .spawn(async move { std::fs::write(path, bytes).ok() })
                    .await
                    .is_some(),
                None => false,
            };
            let _ = this.update(cx, |this, cx| {
                this.exporting = false;
                let toast = if written {
                    Toast::success(copy.exported)
                } else {
                    Toast::error(copy.export_failed)
                };
                toast::show(cx, toast);
                cx.notify();
            });
        })
        .detach();
    }
}
