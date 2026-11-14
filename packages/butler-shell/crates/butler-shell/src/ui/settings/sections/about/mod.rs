//! Settings: About (`AboutSettings.tsx`, `DiagnosticsExportField.tsx`, `OpenSourceLicenses.tsx`).
//! The app describes itself (`/app-info`); the developer mode switch saves `diagnostics_enabled`
//! and the frame shows or hides Logs.
mod copy;
mod diagnostics;

use butler_ds::ui::blocks::key_value_row::KeyValueRow;
use butler_ds::ui::blocks::settings_section::{SettingsPage, SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::inline_reference::InlineReference;
use butler_ds::ui::tooltip::Tooltip;
use gpui::{
    AnyView, App, AppContext as _, Context, IntoElement, ParentElement as _, Render, Window,
};
use serde_json::json;

use self::copy::{Words, words};
use crate::ui::settings::controls::SettingsSwitch;
use crate::ui::settings::state::Load;
use crate::ui::settings::{Save, SectionCtx};

/// `AppInfoView`: the fields the page shows.
struct AppInfo {
    name: Option<String>,
    repository_url: Option<String>,
    protocol_version: Option<String>,
    developer_mode_available: Option<bool>,
}

pub(crate) fn page(ctx: SectionCtx, window: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| AboutPage::new(ctx, window, cx)).into()
}

struct AboutPage {
    ctx: SectionCtx,
    info: Load<AppInfo>,
    exporting: bool,
}

impl AboutPage {
    fn new(ctx: SectionCtx, _: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe(&ctx.state, |_, _, cx| cx.notify()).detach();
        let mut page = Self {
            ctx,
            info: Load::Loading,
            exporting: false,
        };
        page.load(cx);
        page
    }

    /// `api.ts` answers `GET /app-info` from the desktop bridge, not the agent: the app
    /// describes itself (`main.mjs` `appInfoView`). The shell is that app.
    fn load(&mut self, cx: &mut Context<Self>) {
        self.info = Load::Ready(AppInfo {
            name: Some("Butler".to_owned()),
            repository_url: Some("https://github.com/Hexpy-Games/butler".to_owned()),
            protocol_version: Some("butler.app.v1".to_owned()),
            developer_mode_available: Some(true),
        });
        cx.notify();
    }
}

/// `repositoryLabel`: the URL's path without slashes, else its host.
fn repository_label(href: &str) -> String {
    let rest = href.split_once("://").map_or(href, |(_, rest)| rest);
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let path = path.trim_matches('/');
    let label = if path.is_empty() { host } else { path };
    label.to_owned()
}

impl AboutPage {
    /// The `app-info` section.
    fn app_info(&self, copy: &'static Words, cx: &mut Context<Self>) -> SettingsSection {
        let info = match &self.info {
            Load::Ready(info) => Some(info),
            _ => None,
        };
        let repository = match info.and_then(|info| info.repository_url.as_deref()) {
            Some(href) => KeyValueRow::new(copy.app_repository, "").value_element(
                InlineReference::external("app-repository", href.to_owned())
                    .label(repository_label(href)),
            ),
            None => KeyValueRow::new(copy.app_repository, "-"),
        };
        SettingsSection::new("app-info", SettingsSectionKind::Info, copy.app_info)
            .state(self.info.state(|_| false))
            .error_message(copy.load_app_info)
            .on_retry(cx.listener(|this, _, _, cx| this.load(cx)))
            .child(KeyValueRow::new(
                copy.app_name,
                info.and_then(|info| info.name.clone())
                    .unwrap_or_else(|| copy.product.to_owned()),
            ))
            .child(KeyValueRow::new(
                copy.app_version,
                crate::lifecycle::APP_VERSION,
            ))
            .child(repository)
            .child(KeyValueRow::new(
                copy.app_protocol,
                info.and_then(|info| info.protocol_version.clone())
                    .unwrap_or_else(|| "-".to_owned()),
            ))
    }
}

impl Render for AboutPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let app_info = self.app_info(copy, cx);
        let info = match &self.info {
            Load::Ready(info) => Some(info),
            _ => None,
        };
        // CARVE-OUT(shell-task-graph-pref): React sets `taskGraphEnabled` (a local UI preference);
        // the shell has no setter for it yet (`shell/panes.rs` `task_graph_enabled`).
        let experiments =
            SettingsSection::new("experiments", SettingsSectionKind::Form, copy.experiments)
                .holds_fields()
                .child(
                    SettingsSwitch::new("task-graph-enabled", copy.enable_graph)
                        .disabled(true)
                        .disabled_reason(copy.not_yet),
                );
        // CARVE-OUT(G-native): React opens a dialog listing the bundled THIRD_PARTY_NOTICES;
        // the shell has no copy of that file.
        let licenses =
            SettingsSection::new("open-source", SettingsSectionKind::Info, copy.licenses).child(
                Tooltip::new("open-source-licenses-not-yet")
                    .label(copy.not_yet)
                    .child(
                        Button::new("open-source-licenses")
                            .variant(Variant::Ghost)
                            .size(Size::Sm)
                            .text(copy.licenses_title)
                            .disabled(),
                    ),
            );
        let diagnostics =
            SettingsSection::new("diagnostics", SettingsSectionKind::Form, copy.diagnostics)
                .holds_fields()
                .child(diagnostics::field(self, cx));
        let ctx = self.ctx.clone();
        let (enabled, saving) = {
            let state = self.ctx.state.read(cx);
            (state.developer_mode(), state.saving())
        };
        let unavailable = info.is_some_and(|info| info.developer_mode_available == Some(false));
        let developer =
            SettingsSection::new("developer", SettingsSectionKind::Form, copy.developer)
                .holds_fields()
                .child(
                    SettingsSwitch::new("about-developer-mode", copy.developer_mode)
                        .description(copy.developer_mode_description)
                        .checked(enabled)
                        .disabled(saving || unavailable)
                        .on_change(move |enabled, _, cx| {
                            ctx.save(
                                json!({ "diagnostics_enabled": enabled }),
                                Save::default(),
                                cx,
                            );
                        }),
                );
        SettingsPage::new()
            .labels(SectionCtx::labels(cx))
            .section(app_info)
            .section(experiments)
            .section(licenses)
            .section(diagnostics)
            .section(developer)
    }
}
