//! Browsing agent (`BrowsingAgentField.tsx`): uses the same registered model list and server
//! resolution as Settings.
mod copy;

use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::context::Ds;
use gpui::{App, ParentElement as _};
use serde::Deserialize;
use serde_json::json;

use crate::ui::settings::controls::{SettingsOption, SettingsSelect};
use crate::ui::settings::{Save, SectionCtx};
use copy::words;

#[derive(Default, Deserialize)]
struct Slice {
    browser: Option<BrowserSlice>,
}

#[derive(Default, Deserialize)]
struct BrowserSlice {
    browsing_agent: Option<String>,
    auto: Option<Auto>,
}

#[derive(Default, Deserialize)]
struct Auto {
    available: Option<bool>,
    model: Option<String>,
}

#[derive(Default, Deserialize)]
struct Catalog {
    registered_models: Option<Vec<AgentModel>>,
    #[serde(default)]
    models: Vec<AgentModel>,
}

#[derive(Deserialize)]
struct AgentModel {
    #[serde(default)]
    model_ref: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    runtime_supported: bool,
    enabled: Option<bool>,
}

pub(super) fn section(ctx: &SectionCtx, cx: &App) -> SettingsSection {
    let copy = words(Ds::get(cx).lang());
    let state = ctx.state.read(cx);
    let browser = state
        .slice::<Slice>()
        .and_then(|slice| slice.browser)
        .unwrap_or_default();
    let catalog = state
        .catalog()
        .and_then(|value| Catalog::deserialize(value).ok())
        .unwrap_or_default();
    let models: Vec<&AgentModel> = catalog
        .registered_models
        .iter()
        .flatten()
        .filter(|model| model.runtime_supported && model.enabled != Some(false))
        .collect();
    let auto = browser.auto.unwrap_or_default();
    let auto_ref = auto.model.as_deref();
    let auto_model = models
        .iter()
        .copied()
        .chain(catalog.models.iter())
        .find(|model| Some(model.model_ref.as_str()) == auto_ref);
    let auto_name = match (auto.available, auto_model) {
        (Some(true), Some(model)) => model.display_name.as_str(),
        _ => copy.conversation_model,
    };
    let mut options = vec![
        SettingsOption::new("auto", format!("{}{auto_name}", copy.auto_prefix)),
        SettingsOption::new("off", copy.off),
    ];
    options.extend(
        models
            .iter()
            .map(|model| SettingsOption::new(model.model_ref.clone(), model.display_name.clone())),
    );
    let ctx = ctx.clone();
    let select = SettingsSelect::new(
        "browsing-agent",
        copy.label,
        browser.browsing_agent.unwrap_or_else(|| "auto".into()),
    )
    .options(options)
    .disabled(state.saving())
    .on_change(move |value, _, cx| {
        ctx.save(
            json!({ "browser": { "browsing_agent": value.to_string() } }),
            Save::default(),
            cx,
        );
    });
    SettingsSection::new("browsing-agent", SettingsSectionKind::Form, copy.title).child(select)
}
