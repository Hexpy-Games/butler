//! `ModelOptions`, `useModelOptionsFilter`, `useModelChoice` and the model labels of `app/utils.ts`
//! (`modelDisplayName`, `tokenWindowLabel`, `reasoningOptionLabel`, `reasoningBudgetSummary`).
use std::rc::Rc;

use butler_ds::ui::blocks::filtered_select_popover::{
    Filter, FilteredSelectPopover, FooterOption, Group, Item,
};
use butler_ds::ui::context::{Ds, Lang};
use gpui::{AnyElement, App, Entity, IntoElement as _, SharedString, Window};

use crate::ui::source::wire::ReasoningEffort;

/// `AppModelSummary` (app/types.ts:84): the fields the composer menus, the model resolution and
/// the image policy read.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ModelChoice {
    pub(crate) provider_id: SharedString,
    pub(crate) provider_label: SharedString,
    pub(crate) model_id: SharedString,
    pub(crate) model_ref: SharedString,
    pub(crate) display_name: Option<SharedString>,
    pub(crate) context_window_tokens: Option<f64>,
    pub(crate) default_reasoning_effort: Option<ReasoningEffort>,
    pub(crate) reasoning_efforts: Vec<ReasoningEffort>,
    pub(crate) reasoning_budget_tokens: Vec<(ReasoningEffort, f64)>,
    pub(crate) local_reasoning_budget_ratio: Option<f64>,
    /// `availability`: `None` when the catalog does not say; otherwise the wire string.
    pub(crate) availability: Option<SharedString>,
    pub(crate) runtime_supported: bool,
    /// `platform`: set for local runtimes (llama_cpp, ollama, lm_studio, custom).
    pub(crate) platform: Option<SharedString>,
    /// `auth_type`: "chatgpt_oauth" or "api_key".
    pub(crate) auth_type: Option<SharedString>,
    /// `image_input_support`: "supported", "unsupported" or "unknown"; `None` when absent.
    pub(crate) image_input_support: Option<SharedString>,
    pub(crate) image_accepted_mime_types: Option<Vec<String>>,
    pub(crate) image_max_inline_bytes: Option<i64>,
}

/// `ModelOptionsFilter`: the search text and provider filter, kept across reopening.
#[derive(Clone)]
pub(crate) struct ModelOptionsFilter {
    pub(crate) search: SharedString,
    pub(crate) provider: SharedString,
}

impl Default for ModelOptionsFilter {
    fn default() -> Self {
        Self {
            search: SharedString::default(),
            provider: "all".into(),
        }
    }
}

/// `useModelOptionsFilter`: the filter state, owned by `key` in the window.
pub(crate) fn model_options_filter(
    key: &'static str,
    window: &mut Window,
    cx: &mut App,
) -> Entity<ModelOptionsFilter> {
    window.use_keyed_state(key, cx, |_, _| ModelOptionsFilter::default())
}

/// `appCopy.composer` strings of the model chooser.
pub(super) struct Copy {
    pub(super) model: &'static str,
    pub(super) search: &'static str,
    pub(super) all_providers: &'static str,
    pub(super) no_models: &'static str,
    pub(super) reasoning: &'static str,
    pub(super) context_unknown: &'static str,
    pub(super) model_fallback: &'static str,
}

const EN: Copy = Copy {
    model: "Model",
    search: "Search models...",
    all_providers: "All",
    no_models: "No models found",
    reasoning: "Reasoning",
    context_unknown: "context unknown",
    model_fallback: "Model",
};

const KO: Copy = Copy {
    model: "모델",
    search: "모델 검색...",
    all_providers: "전체",
    no_models: "모델을 찾을 수 없습니다",
    reasoning: "추론",
    context_unknown: "컨텍스트 미확인",
    model_fallback: "모델",
};

pub(super) fn copy(lang: Lang) -> &'static Copy {
    if lang == Lang::Ko { &KO } else { &EN }
}

/// `reasoningEffortLabel` (butler-i18n/src/reasoning-effort.ts).
pub(crate) fn reasoning_label(value: &ReasoningEffort, lang: Lang) -> &'static str {
    let ko = lang == Lang::Ko;
    match value {
        ReasoningEffort::None if ko => "없음",
        ReasoningEffort::None => "None",
        ReasoningEffort::Low if ko => "낮음",
        ReasoningEffort::Low => "Low",
        ReasoningEffort::Medium | ReasoningEffort::Unknown if ko => "보통",
        ReasoningEffort::Medium | ReasoningEffort::Unknown => "Medium",
        ReasoningEffort::High if ko => "높음",
        ReasoningEffort::High => "High",
        ReasoningEffort::Xhigh if ko => "매우 높음",
        ReasoningEffort::Xhigh => "Very high",
        ReasoningEffort::Max if ko => "최대",
        ReasoningEffort::Max => "Max",
    }
}

/// `modelDisplayName`.
pub(crate) fn model_display_name(model: &ModelChoice) -> SharedString {
    model
        .display_name
        .clone()
        .unwrap_or_else(|| model.model_id.clone())
}

/// `tokenWindowLabel`.
fn token_window_label(tokens: Option<f64>, copy: &Copy) -> String {
    let Some(tokens) = tokens.filter(|tokens| tokens.is_finite()) else {
        return copy.context_unknown.to_owned();
    };
    if tokens >= 1_000_000. {
        let millions = format!("{:.2}", tokens / 1_000_000.);
        let millions = millions.trim_end_matches('0').trim_end_matches('.');
        return format!("{millions}M API context");
    }
    format!("{}k API context", (tokens / 1000.).round())
}

/// `formatReasoningTokens`.
fn format_reasoning_tokens(tokens: f64) -> String {
    if tokens < 1000. {
        return format!("{}", tokens.round());
    }
    let value = tokens / 1000.;
    if value < 10. && value.fract() != 0. {
        format!("{value:.1}k")
    } else {
        format!("{}k", value.round())
    }
}

fn budget_of(model: &ModelChoice, value: &ReasoningEffort) -> Option<f64> {
    model
        .reasoning_budget_tokens
        .iter()
        .find(|(effort, _)| effort == value)
        .map(|(_, tokens)| *tokens)
        .filter(|tokens| tokens.is_finite() && *tokens > 0.)
}

/// `reasoningOptionLabel`.
pub(crate) fn reasoning_option_label(
    model: &ModelChoice,
    value: &ReasoningEffort,
    lang: Lang,
) -> String {
    if model.provider_id.as_ref() == "local" && *value != ReasoningEffort::None {
        if let Some(ratio) = model
            .local_reasoning_budget_ratio
            .filter(|ratio| ratio.is_finite() && *ratio > 0.)
        {
            return format!("{}%", (ratio.clamp(0., 1.) * 100.).round());
        }
        if let Some(budget) = budget_of(model, value) {
            return format_reasoning_tokens(budget);
        }
    }
    reasoning_label(value, lang).to_owned()
}

/// `reasoningBudgetSummary`.
pub(crate) fn reasoning_budget_summary(
    model: &ModelChoice,
    value: &ReasoningEffort,
    lang: Lang,
) -> String {
    if *value == ReasoningEffort::None {
        return reasoning_label(value, lang).to_owned();
    }
    if model.provider_id.as_ref() == "local" {
        return reasoning_option_label(model, value, lang);
    }
    match budget_of(model, value) {
        Some(budget) => format_reasoning_tokens(budget),
        None => reasoning_label(value, lang).to_owned(),
    }
}

/// `useModelChoice`: the model and reasoning a pick leads to. The caller sets both, persists
/// them (`persistControls`) and marks the selection touched.
pub(crate) fn model_choice(
    next: &ModelChoice,
    reasoning: &ReasoningEffort,
) -> (SharedString, ReasoningEffort) {
    let kept = next.reasoning_efforts.contains(reasoning)
        && !(next.provider_id.as_ref() == "local"
            && next
                .local_reasoning_budget_ratio
                .is_some_and(|ratio| ratio != 0.)
            && *reasoning == ReasoningEffort::None);
    let reasoning = if kept {
        reasoning.clone()
    } else {
        next.default_reasoning_effort
            .clone()
            .unwrap_or(ReasoningEffort::Medium)
    };
    (next.model_ref.clone(), reasoning)
}

/// One reasoning choice below the model list.
pub(crate) struct ReasoningFooterOption {
    pub(crate) label: SharedString,
    pub(crate) selected: bool,
    pub(crate) on_select: Rc<dyn Fn(&mut Window, &mut App)>,
}

/// `ModelOptions`'s `footer`.
pub(crate) struct ModelFooter {
    pub(crate) options: Vec<ReasoningFooterOption>,
}

type Pick = Rc<dyn Fn(&ModelChoice, &mut Window, &mut App)>;

/// `ModelOptions`: the model choices with search and provider filters. `filter` is the state
/// from [`model_options_filter`], so the search and filter survive reopening.
pub(crate) fn model_options(
    id: &'static str,
    models: &[ModelChoice],
    value: &str,
    on_select: Pick,
    footer: Option<ModelFooter>,
    filter: &Entity<ModelOptionsFilter>,
    cx: &mut App,
) -> AnyElement {
    let lang = Ds::get(cx).lang();
    let text = copy(lang);
    let current = filter.read(cx).clone();
    let mut providers: Vec<(SharedString, SharedString)> = Vec::new();
    for model in models {
        if !providers
            .iter()
            .any(|(provider, _)| *provider == model.provider_id)
        {
            providers.push((model.provider_id.clone(), model.provider_label.clone()));
        }
    }
    let query = current.search.trim().to_lowercase();
    let groups = providers
        .iter()
        .map(|(provider, label)| {
            let items = models
                .iter()
                .filter(|item| current.provider == "all" || item.provider_id == current.provider)
                .filter(|item| item.provider_id == *provider)
                .filter(|item| {
                    query.is_empty()
                        || [
                            model_display_name(item).to_string(),
                            item.model_id.to_string(),
                            item.provider_label.to_string(),
                        ]
                        .iter()
                        .any(|field| field.to_lowercase().contains(&query))
                })
                .map(|item| {
                    let pick = on_select.clone();
                    let chosen = item.clone();
                    Item::new(item.model_ref.clone(), model_display_name(item))
                        .description(token_window_label(item.context_window_tokens, text))
                        .selected(item.model_ref.as_ref() == value)
                        .on_select(move |window, cx| pick(&chosen, window, cx))
                })
                .collect();
            Group::new(provider.clone(), label.clone(), items)
        })
        .collect();
    let mut filters = vec![filter_chip(filter, "all", text.all_providers.into())];
    filters.extend(
        providers
            .iter()
            .map(|(provider, label)| filter_chip(filter, provider.clone(), label.clone())),
    );
    let typed = filter.clone();
    let mut popover = FilteredSelectPopover::new(id, text.model, text.search, text.no_models)
        .search(current.search.clone(), move |search, window, cx| {
            typed.update(cx, |state, cx| {
                state.search = search.to_owned().into();
                cx.notify();
            });
            window.refresh();
        })
        .filters(filters, current.provider)
        .groups(groups);
    if let Some(footer) = footer {
        let options = footer
            .options
            .into_iter()
            .map(|option| {
                let select = option.on_select;
                FooterOption::new(option.label, option.selected, move |window, cx| {
                    select(window, cx);
                })
            })
            .collect();
        popover = popover.footer(Some(text.reasoning.into()), options);
    }
    popover.into_any_element()
}

fn filter_chip(
    filter: &Entity<ModelOptionsFilter>,
    id: impl Into<SharedString>,
    label: SharedString,
) -> Filter {
    let id: SharedString = id.into();
    let chosen = id.clone();
    let filter = filter.clone();
    Filter::new(id, label, move |window, cx| {
        filter.update(cx, |state, cx| {
            state.provider = chosen.clone();
            cx.notify();
        });
        window.refresh();
    })
}
