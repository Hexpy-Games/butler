//! The option lists of the selects (`PersonalizationSettingsOptions.ts`).
use std::rc::Rc;

use butler_ds::ui::context::Lang;

use super::copy::Words;
use super::draft::Preset;
use crate::ui::composer::menus::{ModelChoice, model_display_name, token_window_label};
use crate::ui::i18n::composer::menus::copy as menus_copy;
use crate::ui::settings::controls::{SettingsOption, provider_mark};

/// `personaPresetOptionsFrom`
pub(super) fn persona_presets(presets: &[Preset], copy: &Words) -> Vec<SettingsOption> {
    let custom = SettingsOption::new("custom", copy.custom_persona);
    let presets = presets.iter().map(|preset| {
        let mut option = SettingsOption::new(preset.name.clone(), preset.label.clone());
        option.description = Some(preset.preview.clone().into());
        option
    });
    std::iter::once(custom).chain(presets).collect()
}

/// `profilingOptionsFrom`
pub(super) fn profiling_modes(copy: &Words) -> Vec<SettingsOption> {
    ["off", "basic", "deep"]
        .into_iter()
        .zip(
            copy.profiling_labels
                .into_iter()
                .zip(copy.profiling_descriptions),
        )
        .map(|(value, (label, description))| {
            let mut option = SettingsOption::new(value, label);
            option.description = Some(description.into());
            option
        })
        .collect()
}

/// `profilingExtractorModelOptionsFrom`
pub(super) fn extractor_models(
    models: &[ModelChoice],
    copy: &Words,
    lang: Lang,
) -> Vec<SettingsOption> {
    let mut default = SettingsOption::new("default", copy.extractor_default);
    default.description = Some(copy.extractor_default_description.into());
    let models = models.iter().map(|model| {
        let label = format!(
            "{} / {} ({})",
            model.provider_label,
            model_display_name(model),
            token_window_label(model.context_window_tokens, menus_copy(lang))
        );
        let mut option = SettingsOption::new(model.model_ref.clone(), label);
        let (provider, platform) = (model.provider_id.clone(), model.platform.clone());
        option.icon = Some(Rc::new(move || {
            provider_mark(&provider, platform.as_deref(), false)
        }));
        option
    });
    std::iter::once(default).chain(models).collect()
}
