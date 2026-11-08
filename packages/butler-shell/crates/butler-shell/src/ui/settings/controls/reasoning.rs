//! `ReasoningSelect` (ReasoningSelect.tsx) and `effectiveReasoningEffort`.
use std::rc::Rc;

use butler_ds::ui::context::Ds;
use gpui::{App, IntoElement, RenderOnce, SharedString, Window};

use super::{SettingsOption, SettingsSelect};
use crate::ui::composer::menus::{ModelChoice, reasoning_option_label};
use crate::ui::composer::queue::effort_wire;
use crate::ui::i18n::composer::labels::reasoning_label;
use crate::ui::i18n::settings::words;
use crate::ui::source::wire::ReasoningEffort;

type ChooseEffort = Rc<dyn Fn(&ReasoningEffort, &mut Window, &mut App)>;

/// `model?.reasoning_efforts ?? ["none"]`
fn efforts(model: Option<&ModelChoice>) -> Vec<ReasoningEffort> {
    model.map_or_else(
        || vec![ReasoningEffort::None],
        |model| model.reasoning_efforts.clone(),
    )
}

/// `effectiveReasoningEffort`: the stored effort when the model offers it, else the model's
/// default, else its first.
pub(crate) fn effective_reasoning_effort(
    model: Option<&ModelChoice>,
    stored: &ReasoningEffort,
) -> ReasoningEffort {
    let efforts = efforts(model);
    if efforts.contains(stored) {
        return stored.clone();
    }
    if let Some(default) = model
        .and_then(|model| model.default_reasoning_effort.as_ref())
        .filter(|default| efforts.contains(default))
    {
        return default.clone();
    }
    efforts.into_iter().next().unwrap_or(ReasoningEffort::None)
}

/// `ReasoningSelect`: always shows the effective effort; with one option or none it is
/// disabled and says why.
#[derive(IntoElement)]
pub(crate) struct ReasoningSelect {
    id: SharedString,
    label: SharedString,
    model: Option<ModelChoice>,
    value: ReasoningEffort,
    disabled: bool,
    on_change: Option<ChooseEffort>,
}

impl ReasoningSelect {
    pub(crate) fn new(
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        model: Option<&ModelChoice>,
        value: ReasoningEffort,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            model: model.cloned(),
            value,
            disabled: false,
            on_change: None,
        }
    }

    pub(crate) fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub(crate) fn on_change(
        mut self,
        handler: impl Fn(&ReasoningEffort, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for ReasoningSelect {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let lang = Ds::get(cx).lang();
        let model = self.model.as_ref();
        let efforts = efforts(model);
        let label = |effort: &ReasoningEffort| match model {
            Some(model) => reasoning_option_label(model, effort, lang),
            None => reasoning_label(effort, lang).to_owned(),
        };
        let options = efforts
            .iter()
            .filter_map(|effort| Some(SettingsOption::new(effort_wire(effort)?, label(effort))))
            .collect();
        let value = effort_wire(&effective_reasoning_effort(model, &self.value)).unwrap_or("none");
        let mut select = SettingsSelect::new(self.id, self.label, value)
            .options(options)
            .disabled(self.disabled);
        if efforts.len() <= 1 {
            select = select.disabled_reason(words(lang).reasoning_fixed);
        }
        if let Some(handler) = self.on_change {
            select = select.on_change(move |value, window, cx| {
                let chosen = efforts
                    .iter()
                    .find(|effort| effort_wire(effort) == Some(&**value));
                if let Some(effort) = chosen {
                    handler(effort, window, cx);
                }
            });
        }
        select
    }
}
